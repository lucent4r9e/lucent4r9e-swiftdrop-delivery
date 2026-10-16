require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const starterProducts = [
  ['Jollof Rice & Chicken', 'Smoky jollof rice served with grilled chicken.', 4500, '🍗', 'Meals'],
  ['Beef Burger', 'Juicy beef patty, fresh vegetables and house sauce.', 3800, '🍔', 'Meals'],
  ['Party Jollof', 'A generous portion of party-style jollof rice.', 2800, '🍚', 'Meals'],
  ['Chicken Shawarma', 'Chicken, vegetables and creamy garlic sauce.', 3500, '🌯', 'Snacks'],
  ['Meat Pie', 'Flaky pastry with a savoury beef filling.', 1000, '🥟', 'Snacks'],
  ['Chocolate Cake Slice', 'Rich chocolate cake baked fresh.', 1800, '🍰', 'Desserts'],
  ['Fresh Fruit Juice', 'Chilled seasonal fruit juice.', 1200, '🧃', 'Drinks'],
  ['Bottled Water', 'Cold bottled drinking water.', 500, '💧', 'Drinks']
];

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL, description TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL CHECK (price >= 0), emoji VARCHAR(12) NOT NULL DEFAULT '🍽️',
      category VARCHAR(60) NOT NULL DEFAULT 'Meals', available BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY, tracking_code VARCHAR(12) UNIQUE NOT NULL,
      customer_name VARCHAR(120) NOT NULL, phone VARCHAR(40) NOT NULL,
      address TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('delivery','online')),
      payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      status VARCHAR(30) NOT NULL DEFAULT 'received', total INTEGER NOT NULL CHECK (total >= 0),
      items JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM products');
  if (count.rows[0].count === 0) {
    for (const p of starterProducts) {
      await pool.query('INSERT INTO products (name, description, price, emoji, category) VALUES ($1,$2,$3,$4,$5)', p);
    }
  }
}

function adminOnly(req, res, next) {
  const configured = process.env.ADMIN_KEY;
  if (!configured || configured.length < 20) {
    return res.status(503).json({ error: 'Admin access is not configured. Set ADMIN_KEY to a long random secret.' });
  }
  const supplied = req.get('x-admin-key') || '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid admin key.' });
  }
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'SwiftDrop API' }));
app.get('/api/products', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, name, description, price, emoji, category FROM products WHERE available = TRUE ORDER BY id');
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/orders', async (req, res, next) => {
  const { customerName, phone, address, notes = '', paymentMethod = 'delivery', items } = req.body || {};
  if (!customerName?.trim() || !phone?.trim() || !address?.trim()) {
    return res.status(400).json({ error: 'Please provide your name, phone number and delivery address.' });
  }
  if (!['delivery', 'online'].includes(paymentMethod)) return res.status(400).json({ error: 'Invalid payment method.' });
  if (!Array.isArray(items) || items.length === 0 || items.length > 30) return res.status(400).json({ error: 'Your cart is empty or contains too many items.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cleanItems = [];
    let total = 0;
    for (const item of items) {
      const id = Number(item.id), quantity = Number(item.quantity);
      if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'One or more cart items are invalid.' });
      }
      const result = await client.query('SELECT id, name, price, emoji FROM products WHERE id = $1 AND available = TRUE', [id]);
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A product in your cart is no longer available. Refresh and try again.' });
      }
      const p = result.rows[0];
      total += p.price * quantity;
      cleanItems.push({ id: p.id, name: p.name, price: p.price, emoji: p.emoji, quantity });
    }
    const trackingCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const created = await client.query(
      `INSERT INTO orders (tracking_code, customer_name, phone, address, notes, payment_method, payment_status, total, items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, tracking_code, status, payment_status, total, created_at`,
      [trackingCode, customerName.trim(), phone.trim(), address.trim(), String(notes).slice(0, 500), paymentMethod,
       paymentMethod === 'delivery' ? 'pay-on-delivery' : 'pending', total, JSON.stringify(cleanItems)]
    );
    await client.query('COMMIT');
    const order = created.rows[0];
    let paymentUrl = null;
    let paymentNotice = null;
    if (paymentMethod === 'online') {
      if (!process.env.PAYSTACK_SECRET_KEY) {
        paymentNotice = 'Your order was saved, but online payment is not configured yet. Contact the shop to complete payment.';
      } else {
        try {
          const payRes = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: `order-${trackingCode.toLowerCase()}@swiftdrop.local`, amount: total * 100, currency: 'NGN', reference: trackingCode, callback_url: `${req.protocol}://${req.get('host')}/?payment=return&reference=${trackingCode}`, metadata: { trackingCode } })
          });
          const payData = await payRes.json();
          if (payRes.ok && payData.status && payData.data?.authorization_url) paymentUrl = payData.data.authorization_url;
          else paymentNotice = 'Your order was saved, but we could not start online payment. Contact the shop.';
        } catch (_) { paymentNotice = 'Your order was saved, but online payment could not be reached. Contact the shop.'; }
      }
    }
    res.status(201).json({ ...order, paymentUrl, paymentNotice });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(err);
  } finally { client.release(); }
});

app.get('/api/orders/:trackingCode', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT tracking_code, status, payment_method, payment_status, total, items, created_at
       FROM orders WHERE tracking_code = $1`, [String(req.params.trackingCode).toUpperCase()]
    );
    if (!rows[0]) return res.status(404).json({ error: 'We could not find that order. Check the tracking code and try again.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.get('/api/admin/orders', adminOnly, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  } catch (err) { next(err); }
});
app.patch('/api/admin/orders/:id/status', adminOnly, async (req, res, next) => {
  const allowed = ['received', 'preparing', 'ready', 'out-for-delivery', 'delivered', 'cancelled'];
  const status = req.body?.status;
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  try {
    const { rows } = await pool.query('UPDATE orders SET status = $1 WHERE id = $2 RETURNING id, tracking_code, status', [status, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Order not found.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});
app.post('/api/admin/products', adminOnly, async (req, res, next) => {
  const { name, description = '', price, emoji = '🍽️', category = 'Meals' } = req.body || {};
  if (!name?.trim() || !Number.isInteger(Number(price)) || Number(price) < 0) return res.status(400).json({ error: 'A product name and valid price in naira are required.' });
  try {
    const { rows } = await pool.query('INSERT INTO products (name, description, price, emoji, category) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name.trim(), String(description).slice(0, 500), Number(price), String(emoji).slice(0, 12), String(category).slice(0, 60)]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

initDb().then(() => app.listen(port, () => console.log(`SwiftDrop running on port ${port}`)))
  .catch(err => { console.error('Database startup failed:', err.message); process.exit(1); });
