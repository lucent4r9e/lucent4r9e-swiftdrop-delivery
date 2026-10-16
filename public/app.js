const state = { products: [], cart: {}, category: 'All', search: '' };
const money = amount => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(amount);
const $ = id => document.getElementById(id);

async function loadProducts() {
  try {
    const response = await fetch('/api/products');
    if (!response.ok) throw new Error('Could not load products');
    state.products = await response.json();
    renderProducts();
  } catch (_) {
    $('productGrid').innerHTML = '<div class="empty-results">We could not load the menu. Please refresh the page in a moment.</div>';
  }
}
function renderProducts() {
  const products = state.products.filter(p => (state.category === 'All' || p.category === state.category) && `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(state.search.toLowerCase()));
  $('productGrid').innerHTML = products.length ? products.map(p => `
    <article class="product-card"><div class="product-art"><span class="category-tag">${escapeHtml(p.category)}</span><span class="food-emoji">${escapeHtml(p.emoji)}</span></div><div class="product-info"><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.description)}</p><div class="product-bottom"><span class="price">${money(p.price)}</span><button class="add-button" data-add="${p.id}" aria-label="Add ${escapeHtml(p.name)} to cart">+</button></div></div></article>`).join('') : '<div class="empty-results">No matches yet. Try another search or category.</div>';
  document.querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => addToCart(Number(button.dataset.add))));
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function addToCart(id) {
  state.cart[id] = (state.cart[id] || 0) + 1;
  renderCart(); showToast('Added to your cart ✨');
}
function cartProducts() { return Object.entries(state.cart).map(([id, quantity]) => { const product = state.products.find(p => p.id === Number(id)); return product ? { ...product, quantity } : null; }).filter(Boolean); }
function cartTotal() { return cartProducts().reduce((sum, p) => sum + p.price * p.quantity, 0); }
function cartCount() { return Object.values(state.cart).reduce((sum, quantity) => sum + quantity, 0); }
function renderCart() {
  const products = cartProducts();
  $('cartCount').textContent = cartCount(); $('drawerCount').textContent = `(${cartCount()})`;
  $('subtotal').textContent = money(cartTotal()); $('checkoutTotal').textContent = money(cartTotal());
  $('cartItems').innerHTML = products.length ? products.map(p => `<div class="cart-row"><div class="cart-row-art">${escapeHtml(p.emoji)}</div><div><h3>${escapeHtml(p.name)}</h3><small>${money(p.price)} each</small><div class="qty-control"><button data-minus="${p.id}" aria-label="Remove one">−</button><span>${p.quantity}</span><button data-plus="${p.id}" aria-label="Add one">+</button></div></div><span class="cart-row-price">${money(p.price * p.quantity)}</span></div>`).join('') : '<div class="empty-cart"><span style="font-size:34px">🛍️</span><b>Your cart is taking a little nap.</b><span>Add something delicious to wake it up.</span></div>';
  document.querySelectorAll('[data-minus]').forEach(b => b.addEventListener('click', () => { const id = Number(b.dataset.minus); state.cart[id]--; if (state.cart[id] <= 0) delete state.cart[id]; renderCart(); }));
  document.querySelectorAll('[data-plus]').forEach(b => b.addEventListener('click', () => { state.cart[Number(b.dataset.plus)]++; renderCart(); }));
  $('checkoutButton').disabled = !products.length; $('checkoutButton').style.opacity = products.length ? '1' : '.5';
}
function showCart() { $('overlay').classList.add('open'); $('cartDrawer').classList.add('open'); $('cartDrawer').setAttribute('aria-hidden','false'); document.body.style.overflow='hidden'; }
function hideCart() { $('overlay').classList.remove('open'); $('cartDrawer').classList.remove('open'); $('cartDrawer').setAttribute('aria-hidden','true'); document.body.style.overflow=''; }
function showToast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => $('toast').classList.remove('show'), 2200); }
document.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => { state.category = button.dataset.category; document.querySelectorAll('[data-category]').forEach(b => b.classList.toggle('active', b === button)); renderProducts(); }));
$('searchInput').addEventListener('input', event => { state.search = event.target.value; renderProducts(); });
$('openCart').addEventListener('click', showCart); $('closeCart').addEventListener('click', hideCart); $('overlay').addEventListener('click', hideCart);
$('checkoutButton').addEventListener('click', () => { if (!cartCount()) return; hideCart(); $('checkoutModal').classList.add('open'); document.body.style.overflow='hidden'; $('checkoutMessage').textContent=''; });
function closeCheckout() { $('checkoutModal').classList.remove('open'); document.body.style.overflow=''; }
$('closeCheckout').addEventListener('click', closeCheckout);
$('checkoutModal').addEventListener('click', e => { if (e.target === $('checkoutModal')) closeCheckout(); });
$('checkoutForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!cartCount()) return;
  const button = $('placeOrder'); button.disabled = true; button.textContent = 'Placing your order…'; $('checkoutMessage').textContent = '';
  const form = new FormData(event.currentTarget);
  const payload = { customerName: form.get('customerName'), phone: form.get('phone'), address: form.get('address'), notes: form.get('notes'), paymentMethod: form.get('paymentMethod'), items: cartProducts().map(p => ({ id: p.id, quantity: p.quantity })) };
  try {
    const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not place your order.');
    state.cart = {}; renderCart(); event.currentTarget.reset(); closeCheckout();
    hideCart();
    if (result.paymentUrl) { window.location.href = result.paymentUrl; return; }
    $('trackResult').classList.remove('error');
    $('trackResult').innerHTML = `Order placed! Your tracking code is <b>${escapeHtml(result.tracking_code)}</b>. Save it to check your order status.`;
    $('trackingCode').value = result.tracking_code;
    document.getElementById('trackForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (result.paymentNotice) showToast(result.paymentNotice); else showToast('Order placed successfully! 🎉');
  } catch (error) {
    $('checkoutMessage').textContent = error.message; $('checkoutMessage').classList.add('error');
  } finally { button.disabled = false; button.innerHTML = 'Place my order <span>→</span>'; }
});
$('trackForm').addEventListener('submit', async event => {
  event.preventDefault(); const code = $('trackingCode').value.trim().toUpperCase(); const resultBox = $('trackResult'); resultBox.classList.remove('error'); resultBox.textContent = 'Checking your order…';
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(code)}`); const order = await response.json();
    if (!response.ok) throw new Error(order.error || 'Could not find order.');
    const labels = { received:'Order received', preparing:'Being prepared', ready:'Ready for pickup', 'out-for-delivery':'Out for delivery', delivered:'Delivered', cancelled:'Cancelled' };
    resultBox.innerHTML = `Order <b>${escapeHtml(order.tracking_code)}</b> · <b>${escapeHtml(labels[order.status] || order.status)}</b><br>Total: <b>${money(order.total)}</b> · Payment: ${escapeHtml(order.payment_status)}`;
  } catch (error) { resultBox.classList.add('error'); resultBox.textContent = error.message; }
});
$('year').textContent = new Date().getFullYear();
renderCart(); loadProducts();
