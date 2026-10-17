// InventarioSimple — interfaz
'use strict';
const $app = document.getElementById('app');
let settings = null, products = [], todayStr = '';
let cart = [], payMethod = null, discount = 0;

// ---------- Utilidades ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function money(n) {
  const c = settings?.currency || 'COP';
  try { return new Intl.NumberFormat(settings?.locale || 'es-CO', { style: 'currency', currency: c, maximumFractionDigits: c === 'COP' ? 0 : 2 }).format(n || 0); }
  catch { return String(n || 0); }
}
const qtyFmt = n => (Math.round(n * 100) / 100).toLocaleString('es-CO');
const fmtDay = (d, opts = { day: 'numeric', month: 'short' }) => new Intl.DateTimeFormat('es', { ...opts, timeZone: 'UTC' }).format(new Date(d + 'T12:00:00Z'));
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const formData = f => Object.fromEntries(new FormData(f).entries());
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800); }
async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !/\/api\/(login|setup)$/.test(path)) { location.hash = '#/login'; route(); }
  if (!res.ok) { const e = new Error(data.error || 'Error'); e.status = res.status; throw e; }
  return data;
}
const MV = { inicial: 'Inventario inicial', entrada: 'Entrada (compra)', ajuste: 'Ajuste', conteo: 'Conteo físico', venta: 'Venta', anulacion: 'Venta anulada' };

function shell(active, content) {
  const link = (h, label, key) => `<a href="${h}" class="${active === key ? 'active' : ''}">${label}</a>`;
  $app.innerHTML = `<div class="layout"><nav class="side">
    <div class="brand"><img src="/icon.svg" alt="">InventarioSimple</div>
    ${link('#/', 'Vender', 'pos')}${link('#/productos', 'Productos', 'productos')}${link('#/ventas', 'Ventas', 'ventas')}${link('#/resumen', 'Resumen', 'resumen')}${link('#/ajustes', 'Ajustes', 'ajustes')}
    <div class="spacer"></div><a href="#" id="logout">Cerrar sesión</a></nav><main style="max-width:1280px">${content}</main></div>`;
  document.getElementById('logout').onclick = async e => { e.preventDefault(); await api('/api/logout', { method: 'POST', body: {} }); location.hash = '#/login'; route(); };
}

// ---------- Acceso ----------
function viewSetup() {
  $app.innerHTML = `<div class="auth card"><h1>Bienvenido a InventarioSimple</h1><p class="muted">Configura tu tienda y crea la contraseña.</p>
    <form id="f"><div class="field"><label>Código de configuración</label><input name="setupCode" required autocomplete="off" placeholder="Aparece en los registros (logs) del servidor"></div>
    <div class="field"><label>Nombre de la tienda</label><input name="businessName" required></div>
    <div class="field"><label>Contraseña (mínimo 8 caracteres)</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
    <button class="btn primary" style="width:100%">Empezar</button></form></div>`;
  document.getElementById('f').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/setup', { method: 'POST', body: formData(e.target) }); location.hash = '#/productos'; route(); toast('¡Listo! Agrega tus productos.'); } catch (err) { toast(err.message); }
  };
}
function viewLogin() {
  $app.innerHTML = `<div class="auth card"><div class="row" style="margin-bottom:1rem"><img src="/icon.svg" width="36" alt=""><h1 style="margin:0">InventarioSimple</h1></div>
    <form id="f"><div class="field"><label>Contraseña</label><input name="password" type="password" required autofocus autocomplete="current-password"></div>
    <button class="btn primary" style="width:100%">Entrar</button></form></div>`;
  document.getElementById('f').onsubmit = async e => { e.preventDefault(); try { await api('/api/login', { method: 'POST', body: formData(e.target) }); location.hash = '#/'; route(); } catch (err) { toast(err.message); } };
}

// ---------- Punto de venta ----------
async function viewPOS() {
  products = await api('/api/products');
  payMethod ||= settings.paymentMethods[0];
  const cats = [...new Set(products.filter(p => p.active).map(p => p.category).filter(Boolean))].sort();
  shell('pos', `<div class="pos">
    <div class="card"><div class="row"><input id="q" placeholder="Buscar o escanear código de barras y presionar Enter…" autofocus style="flex:1;min-width:200px">
      ${cats.length ? `<select id="cat" style="width:auto"><option value="">Todas</option>${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select>` : ''}</div>
      <div class="pgrid" id="grid"></div></div>
    <div class="card cart"><h2>Venta actual</h2><div id="lines"></div>
      <div class="row between" style="margin-top:.75rem"><label for="disc" style="margin:0">Descuento</label><input id="disc" type="number" min="0" step="any" value="${discount || ''}" placeholder="0" style="width:130px;text-align:right"></div>
      <div class="bigtotal" id="total"></div>
      <label style="margin-top:.5rem">Método de pago</label><div class="methods" id="methods"></div>
      <div id="cashBox" style="margin-top:.6rem"></div>
      <div class="field" style="margin-top:.6rem"><label for="cust">Cliente (opcional)</label><input id="cust" placeholder="Nombre o cédula"></div>
      <div class="row"><button class="btn primary" id="pay" style="flex:1;justify-content:center;font-size:1.05rem">Cobrar</button><button class="btn" id="clear">Vaciar</button></div></div></div>
    <button class="mobilebar" id="mbar" hidden></button>`);
  document.getElementById('mbar').onclick = () => document.querySelector('.cart').scrollIntoView({ behavior: 'smooth' });
  const grid = document.getElementById('grid'), q = document.getElementById('q'), cat = document.getElementById('cat');
  const filtered = () => {
    const t = q.value.trim().toLowerCase(), c = cat?.value || '';
    return products.filter(p => p.active && (!c || p.category === c) && (!t || p.name.toLowerCase().includes(t) || (p.sku || '').toLowerCase().includes(t)));
  };
  const renderGrid = () => {
    const list = filtered();
    grid.innerHTML = list.length ? list.map(p => {
      const out = !settings.allowNegative && p.stock <= 0;
      return `<button class="pitem" data-id="${p.id}" ${out ? 'disabled' : ''}><div class="n">${esc(p.name)}</div><div class="p">${money(p.price)}</div>
        <div class="s ${p.stock <= p.minStock ? 'low' : ''}">${out ? 'Agotado' : `Stock: ${qtyFmt(p.stock)} ${esc(p.unit)}`}</div></button>`;
    }).join('') : `<p class="muted">${products.length ? 'Ningún producto coincide.' : 'Aún no tienes productos. <a href="#/productos">Agrégalos aquí</a>.'}</p>`;
    grid.querySelectorAll('.pitem').forEach(b => b.onclick = () => { addToCart(b.dataset.id); q.focus(); });
  };
  q.oninput = renderGrid; if (cat) cat.onchange = renderGrid;
  q.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = q.value.trim().toLowerCase(); if (!t) return;
    const exact = products.find(p => p.active && p.sku && p.sku.toLowerCase() === t);
    const list = filtered();
    const pick = exact || (list.length === 1 ? list[0] : null);
    if (pick) { addToCart(pick.id); q.value = ''; renderGrid(); } else toast(list.length ? 'Hay varios productos: toca el que quieres' : 'No se encontró ese código');
  };
  document.getElementById('disc').oninput = e => { discount = Math.max(0, Number(e.target.value) || 0); renderCart(); };
  document.getElementById('clear').onclick = () => { if (cart.length && !confirm('¿Vaciar la venta actual?')) return; cart = []; discount = 0; document.getElementById('disc').value = ''; renderCart(); };
  document.getElementById('pay').onclick = checkout;
  renderGrid(); renderCart();
}
function addToCart(pid) {
  const p = products.find(x => x.id === pid); if (!p) return;
  const line = cart.find(l => l.productId === pid);
  const inCart = line ? line.qty : 0;
  if (!settings.allowNegative && inCart + 1 > p.stock) return toast(`Solo hay ${qtyFmt(p.stock)} de ${p.name}`);
  if (line) line.qty++; else cart.push({ productId: pid, name: p.name, price: p.price, qty: 1 });
  renderCart();
}
function cartTotals() {
  const subtotal = cart.reduce((s, l) => s + l.qty * l.price, 0);
  const d = Math.min(discount, subtotal);
  return { subtotal, discount: d, total: subtotal - d };
}
function renderCart() {
  const box = document.getElementById('lines'); if (!box) return;
  box.innerHTML = cart.length ? cart.map((l, i) => `<div class="cline"><div><strong>${esc(l.name)}</strong><div class="muted" style="font-size:.85rem">${money(l.price)} c/u</div></div>
    <div class="lt">${money(l.qty * l.price)}</div>
    <div class="qty"><button class="btn sm" data-dec="${i}" aria-label="Menos">−</button><input type="number" min="0" step="any" value="${l.qty}" data-q="${i}" aria-label="Cantidad"><button class="btn sm" data-inc="${i}" aria-label="Más">+</button></div>
    <div style="text-align:right"><button class="btn sm danger" data-rm="${i}">Quitar</button></div></div>`).join('') : '<p class="muted">Toca un producto o escanea su código.</p>';
  const t = cartTotals();
  const mbar = document.getElementById('mbar');
  if (mbar) { const n = cart.reduce((a, l) => a + l.qty, 0); mbar.hidden = !cart.length; mbar.textContent = `Ver venta · ${qtyFmt(n)} ${n === 1 ? 'producto' : 'productos'} · ${money(t.total)}`; }
  document.getElementById('total').innerHTML = `${t.discount ? `<div class="muted" style="font-size:.9rem;font-weight:400">Subtotal ${money(t.subtotal)} · Descuento −${money(t.discount)}</div>` : ''}${money(t.total)}`;
  const mBox = document.getElementById('methods');
  mBox.innerHTML = settings.paymentMethods.map(m => `<button class="${m === payMethod ? 'sel' : ''}" data-m="${esc(m)}">${esc(m)}</button>`).join('');
  mBox.querySelectorAll('button').forEach(b => b.onclick = () => { payMethod = b.dataset.m; renderCart(); });
  const cash = document.getElementById('cashBox');
  if (payMethod === 'Efectivo') {
    const prev = cash.querySelector('input')?.value || '';
    cash.innerHTML = `<div class="row between"><label for="rec" style="margin:0">Recibido</label><input id="rec" type="number" min="0" step="any" value="${esc(prev)}" style="width:150px;text-align:right"></div><div class="change" id="chg"></div>`;
    const rec = document.getElementById('rec');
    const upd = () => { const r = Number(rec.value) || 0; document.getElementById('chg').textContent = r ? (r >= t.total ? 'Vueltas: ' + money(r - t.total) : 'Faltan ' + money(t.total - r)) : ''; };
    rec.oninput = upd; upd();
  } else cash.innerHTML = '';
  const products_ = products;
  box.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => { const l = cart[b.dataset.inc]; const p = products_.find(x => x.id === l.productId); if (!settings.allowNegative && l.qty + 1 > p.stock) return toast(`Solo hay ${qtyFmt(p.stock)}`); l.qty++; renderCart(); });
  box.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => { const l = cart[b.dataset.dec]; l.qty--; if (l.qty <= 0) cart.splice(b.dataset.dec, 1); renderCart(); });
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { cart.splice(b.dataset.rm, 1); renderCart(); });
  box.querySelectorAll('[data-q]').forEach(inp => inp.onchange = () => {
    const l = cart[inp.dataset.q]; const p = products_.find(x => x.id === l.productId); let v = Number(inp.value) || 0;
    if (!settings.allowNegative && v > p.stock) { v = p.stock; toast(`Solo hay ${qtyFmt(p.stock)}`); }
    if (v <= 0) cart.splice(inp.dataset.q, 1); else l.qty = v; renderCart();
  });
}
async function checkout() {
  if (!cart.length) return toast('La venta está vacía');
  const t = cartTotals();
  const rec = Number(document.getElementById('rec')?.value) || 0;
  if (payMethod === 'Efectivo' && rec && rec < t.total) return toast('El efectivo recibido no alcanza');
  const btn = document.getElementById('pay'); btn.disabled = true;
  try {
    const sale = await api('/api/sales', { method: 'POST', body: { items: cart.map(l => ({ productId: l.productId, qty: l.qty, price: l.price })), discount: t.discount, method: payMethod, received: rec, customer: document.getElementById('cust').value } });
    cart = []; discount = 0;
    showReceipt(sale, true);
  } catch (err) { toast(err.message); btn.disabled = false; }
}
function ticketHtml(s) {
  const st = settings;
  return `<div class="ticket"><div class="c"><strong>${esc(st.businessName)}</strong><br>${[st.taxId && 'NIT ' + st.taxId, st.address, st.phone].filter(Boolean).map(esc).join('<br>')}</div><hr>
    <div>Venta N.° ${esc(s.number)}<br>${esc(fmtDay(s.date, { day: '2-digit', month: '2-digit', year: 'numeric' }))} ${esc(s.time)}${s.customer ? '<br>Cliente: ' + esc(s.customer) : ''}</div><hr>
    <table style="width:100%">${s.items.map(i => `<tr><td colspan="2">${esc(i.name)}</td></tr><tr><td>${qtyFmt(i.qty)} x ${money(i.price)}</td><td style="text-align:right">${money(i.total)}</td></tr>`).join('')}</table><hr>
    <table style="width:100%">${s.discount ? `<tr><td>Subtotal</td><td style="text-align:right">${money(s.subtotal)}</td></tr><tr><td>Descuento</td><td style="text-align:right">-${money(s.discount)}</td></tr>` : ''}
    <tr><td><strong>TOTAL</strong></td><td style="text-align:right"><strong>${money(s.total)}</strong></td></tr>
    <tr><td>${esc(s.method)}</td><td style="text-align:right">${money(s.received || s.total)}</td></tr>${s.change ? `<tr><td>Vueltas</td><td style="text-align:right">${money(s.change)}</td></tr>` : ''}</table><hr>
    ${s.status === 'anulada' ? '<div class="c"><strong>*** VENTA ANULADA ***</strong></div><hr>' : ''}
    <div class="c">${esc(st.receiptFooter)}<br><small>Comprobante de venta. No es factura electrónica.</small></div></div>`;
}
function showReceipt(s, fresh) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="box">${fresh ? `<h2 style="text-align:center">Venta registrada ✓</h2>${s.change ? `<p class="change" style="text-align:center">Vueltas: ${money(s.change)}</p>` : ''}` : ''}${ticketHtml(s)}
    <div class="row" style="margin-top:1rem"><button class="btn" id="pr">Imprimir</button><button class="btn primary" id="ok" style="flex:1;justify-content:center">${fresh ? 'Nueva venta' : 'Cerrar'}</button></div></div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.body.classList.remove('print-ticket'); if (fresh) viewPOS(); };
  ov.querySelector('#ok').onclick = close;
  ov.querySelector('#ok').focus();
  ov.querySelector('#pr').onclick = () => { document.body.classList.add('print-ticket'); window.print(); setTimeout(() => document.body.classList.remove('print-ticket'), 500); };
  ov.onclick = e => { if (e.target === ov) close(); };
  ov.onkeydown = e => { if (e.key === 'Escape') close(); };
}

// ---------- Productos ----------
function productFormHtml(p) {
  p ||= { name: '', sku: '', category: '', unit: 'und', price: '', cost: '', minStock: 0, active: true };
  const cats = [...new Set(products.map(x => x.category).filter(Boolean))];
  return `<form class="card" id="pf"><h2>${p.id ? 'Editar producto' : 'Nuevo producto'}</h2><div class="grid cols-2">
    <div class="field"><label>Nombre *</label><input name="name" required value="${esc(p.name)}"></div>
    <div class="field"><label>Código / código de barras</label><input name="sku" value="${esc(p.sku)}" placeholder="Escanéalo o escríbelo"></div>
    <div class="field"><label>Categoría</label><input name="category" value="${esc(p.category)}" list="cats"><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="field"><label>Unidad</label><input name="unit" value="${esc(p.unit)}" placeholder="und, kg, lb, caja…"></div>
    <div class="field"><label>Precio de venta *</label><input name="price" type="number" min="0" step="any" required value="${esc(p.price)}"></div>
    <div class="field"><label>Costo</label><input name="cost" type="number" min="0" step="any" value="${esc(p.cost)}"></div>
    <div class="field"><label>Avisar cuando queden</label><input name="minStock" type="number" min="0" step="any" value="${esc(p.minStock)}"></div>
    ${!p.id ? '<div class="field"><label>Stock inicial</label><input name="initialStock" type="number" min="0" step="any" value="0"></div>' : ''}</div>
    <label style="display:flex;gap:.5rem;align-items:center;color:var(--text)"><input type="checkbox" name="active" ${p.active ? 'checked' : ''} style="width:auto"> Disponible para vender</label>
    <div class="row" style="margin-top:.75rem"><button class="btn primary">Guardar</button><button type="button" class="btn" id="pcx">Cancelar</button></div></form>`;
}
async function viewProducts() {
  products = await api('/api/products');
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
  shell('productos', `<div class="row between"><h1>Productos</h1><div class="row"><a class="btn" href="/api/products.csv">Exportar CSV</a><button class="btn primary" id="add">+ Nuevo producto</button></div></div>
    <div id="formBox"></div>
    <div class="card"><div class="row" style="margin-bottom:.75rem"><input id="q" placeholder="Buscar por nombre o código…" style="flex:1;min-width:200px">
      <select id="cat" style="width:auto"><option value="">Todas las categorías</option>${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select>
      <label style="display:flex;gap:.4rem;align-items:center;margin:0;color:var(--text)"><input type="checkbox" id="low" style="width:auto"> Solo stock bajo</label></div>
      <div class="table-wrap"><table><thead><tr><th>Producto</th><th>Código</th><th class="num">Precio</th><th class="num">Costo</th><th class="num">Margen</th><th class="num">Stock</th></tr></thead><tbody id="rows"></tbody></table></div></div>`);
  const render = () => {
    const t = document.getElementById('q').value.toLowerCase(), c = document.getElementById('cat').value, low = document.getElementById('low').checked;
    const list = products.filter(p => (!c || p.category === c) && (!low || p.stock <= p.minStock) && (!t || p.name.toLowerCase().includes(t) || (p.sku || '').toLowerCase().includes(t))).sort((a, b) => a.name.localeCompare(b.name));
    document.getElementById('rows').innerHTML = list.length ? list.map(p => `<tr class="click" data-id="${p.id}"><td><strong>${esc(p.name)}</strong>${p.category ? `<div class="muted" style="font-size:.85rem">${esc(p.category)}</div>` : ''}${!p.active ? ' <span class="badge">Inactivo</span>' : ''}</td>
      <td>${esc(p.sku)}</td><td class="num">${money(p.price)}</td><td class="num">${p.cost ? money(p.cost) : '—'}</td><td class="num">${p.cost && p.price ? Math.round(100 * (p.price - p.cost) / p.price) + '%' : '—'}</td>
      <td class="num ${p.stock <= p.minStock ? 'stock-low' : ''}">${qtyFmt(p.stock)} ${esc(p.unit)}</td></tr>`).join('') : `<tr><td colspan="6" class="empty">${products.length ? 'Ningún producto coincide.' : 'Agrega tu primer producto.'}</td></tr>`;
    document.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => { location.hash = '#/producto/' + tr.dataset.id; });
  };
  render();
  document.getElementById('q').oninput = render; document.getElementById('cat').onchange = render; document.getElementById('low').onchange = render;
  document.getElementById('add').onclick = () => {
    const box = document.getElementById('formBox'); box.innerHTML = productFormHtml(null);
    document.getElementById('pcx').onclick = () => { box.innerHTML = ''; };
    document.getElementById('pf').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/products', { method: 'POST', body: { ...formData(e.target), active: e.target.active.checked } }); toast('Producto creado'); viewProducts(); } catch (err) { toast(err.message); }
    };
    box.querySelector('input').focus();
  };
}
async function viewProduct(pid) {
  if (!products.length) products = await api('/api/products');
  const p = await api('/api/products/' + pid);
  shell('productos', `<p><a href="#/productos">← Productos</a></p>
    <div class="card"><div class="row between"><div><h1 style="margin:0">${esc(p.name)}</h1><div class="muted">${[p.sku, p.category].filter(Boolean).map(esc).join(' · ')}</div></div><button class="btn" id="edit">Editar</button></div>
      <div class="grid stats" style="margin-top:1rem">
        <div class="stat"><div class="label">Stock</div><div class="value ${p.stock <= p.minStock ? 'stock-low' : ''}">${qtyFmt(p.stock)} ${esc(p.unit)}</div></div>
        <div class="stat"><div class="label">Precio</div><div class="value">${money(p.price)}</div></div>
        <div class="stat"><div class="label">Costo promedio</div><div class="value">${p.cost ? money(p.cost) : '—'}</div></div>
        <div class="stat"><div class="label">Valor en bodega</div><div class="value">${money(Math.max(0, p.stock) * p.cost)}</div></div></div></div>
    <div id="formBox"></div>
    <div class="grid cols-2">
      <form class="card" id="inF"><h2>Entrada de mercancía</h2><div class="grid cols-2">
        <div class="field"><label>Cantidad recibida</label><input name="qty" type="number" min="0" step="any" required></div>
        <div class="field"><label>Costo unitario (opcional)</label><input name="unitCost" type="number" min="0" step="any" placeholder="${p.cost || ''}"></div></div>
        <div class="field"><label>Nota</label><input name="note" placeholder="Proveedor, factura de compra…"></div><button class="btn primary">Registrar entrada</button></form>
      <form class="card" id="cntF"><h2>Ajustar inventario</h2>
        <div class="field"><label>Tipo</label><select name="type"><option value="conteo">Conteo físico: escribo cuántas hay</option><option value="ajuste">Ajuste: sumo o resto (usa negativo para pérdidas)</option></select></div>
        <div class="grid cols-2"><div class="field"><label>Cantidad</label><input name="qty" type="number" step="any" required></div>
        <div class="field"><label>Motivo</label><input name="note" placeholder="Vencido, dañado, conteo…"></div></div><button class="btn">Guardar ajuste</button></form></div>
    <div class="card"><h2>Movimientos (kárdex)</h2>${p.movements.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th class="num">Cantidad</th><th class="num">Saldo</th></tr></thead><tbody>
      ${p.movements.map(m => `<tr><td>${esc(fmtDay(m.date))} ${esc(m.time)}</td><td>${esc(MV[m.type] || m.type)}</td><td class="muted">${esc([m.ref, m.note].filter(Boolean).join(' · '))}</td>
        <td class="num ${m.qty >= 0 ? 'mv-pos' : 'mv-neg'}">${m.qty > 0 ? '+' : ''}${qtyFmt(m.qty)}</td><td class="num">${qtyFmt(m.stockAfter)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Sin movimientos todavía.</p>'}</div>
    <p><button class="btn danger" id="del">Eliminar producto</button></p>`);
  const reload = () => viewProduct(pid);
  const move = async (body, msg) => { try { const r = await api('/api/movements', { method: 'POST', body: { ...body, productId: p.id } }); toast(r.unchanged ? 'El conteo coincide, no hubo cambios' : msg); reload(); } catch (err) { toast(err.message); } };
  document.getElementById('inF').onsubmit = e => { e.preventDefault(); move({ ...formData(e.target), type: 'entrada' }, 'Entrada registrada'); };
  document.getElementById('cntF').onsubmit = e => { e.preventDefault(); move(formData(e.target), 'Inventario ajustado'); };
  document.getElementById('edit').onclick = () => {
    const box = document.getElementById('formBox'); box.innerHTML = productFormHtml(p);
    document.getElementById('pcx').onclick = () => { box.innerHTML = ''; };
    document.getElementById('pf').onsubmit = async e => { e.preventDefault(); try { await api('/api/products/' + p.id, { method: 'PUT', body: { ...formData(e.target), active: e.target.active.checked } }); toast('Producto guardado'); products = []; reload(); } catch (err) { toast(err.message); } };
  };
  document.getElementById('del').onclick = async () => {
    if (!confirm(`¿Eliminar ${p.name}? Si ya tiene ventas, solo se desactiva para conservar el historial.`)) return;
    const r = await api('/api/products/' + p.id, { method: 'DELETE' }); toast(r.archived ? 'Tenía ventas: quedó inactivo' : 'Producto eliminado'); products = []; location.hash = '#/productos';
  };
}

// ---------- Ventas ----------
async function viewSales(from, to) {
  from ||= todayStr; to ||= todayStr;
  const sales = await api(`/api/sales?from=${from}&to=${to}`);
  const ok = sales.filter(s => s.status === 'ok');
  const total = ok.reduce((a, s) => a + s.total, 0);
  const byMethod = {}; ok.forEach(s => { byMethod[s.method] = (byMethod[s.method] || 0) + s.total; });
  shell('ventas', `<div class="row between"><h1>Ventas</h1><a class="btn" href="/api/sales.csv?from=${from}&to=${to}">Exportar CSV</a></div>
    <form class="card row" id="rf"><label style="margin:0">Desde</label><input type="date" name="from" value="${from}" style="width:auto"><label style="margin:0">Hasta</label><input type="date" name="to" value="${to}" style="width:auto">
      <button class="btn">Ver</button><button type="button" class="btn sm" data-r="0">Hoy</button><button type="button" class="btn sm" data-r="7">7 días</button><button type="button" class="btn sm" data-r="30">30 días</button></form>
    <div class="grid stats"><div class="card stat"><div class="label">Total vendido</div><div class="value">${money(total)}</div></div>
      <div class="card stat"><div class="label">Ventas</div><div class="value">${ok.length}</div></div>
      ${Object.entries(byMethod).map(([k, v]) => `<div class="card stat"><div class="label">${esc(k)}</div><div class="value">${money(v)}</div></div>`).join('')}</div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>N.°</th><th>Fecha</th><th>Productos</th><th>Método</th><th>Estado</th><th class="num">Total</th></tr></thead><tbody>
      ${sales.length ? sales.map(s => `<tr class="click" data-id="${s.id}"><td><strong>${esc(s.number)}</strong></td><td>${esc(fmtDay(s.date))} ${esc(s.time)}</td>
        <td class="muted">${esc(s.items.map(i => `${qtyFmt(i.qty)} ${i.name}`).join(', ').slice(0, 70))}</td><td>${esc(s.method)}</td>
        <td><span class="badge ${s.status}">${s.status === 'ok' ? 'OK' : 'Anulada'}</span></td><td class="num">${money(s.total)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No hay ventas en estas fechas.</td></tr>'}</tbody></table></div></div>`);
  document.getElementById('rf').onsubmit = e => { e.preventDefault(); const f = formData(e.target); location.hash = `#/ventas/${f.from}/${f.to}`; };
  document.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { location.hash = `#/ventas/${addDays(todayStr, -Number(b.dataset.r))}/${todayStr}`; });
  document.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => {
    const s = sales.find(x => x.id === tr.dataset.id);
    showReceipt(s, false);
    if (s.status === 'ok') {
      const box = document.querySelector('.overlay .box .row');
      box.insertAdjacentHTML('beforeend', '<button class="btn danger" id="void">Anular</button>');
      document.getElementById('void').onclick = async () => {
        const reason = prompt('Motivo de la anulación (el stock se devuelve al inventario):');
        if (reason === null) return;
        try { await api(`/api/sales/${s.id}/void`, { method: 'POST', body: { reason } }); toast('Venta anulada y stock devuelto'); document.querySelector('.overlay').remove(); viewSales(from, to); } catch (err) { toast(err.message); }
      };
    }
  });
}

// ---------- Resumen ----------
async function viewSummary() {
  const d = await api('/api/dashboard');
  const max = Math.max(1, ...Object.values(d.daily));
  shell('resumen', `<h1>Resumen</h1>
    <div class="grid stats">
      <div class="card stat"><div class="label">Vendido hoy (${d.todayCount})</div><div class="value">${money(d.todayTotal)}</div></div>
      <div class="card stat"><div class="label">Vendido este mes</div><div class="value">${money(d.monthTotal)}</div></div>
      <div class="card stat"><div class="label">Utilidad bruta del mes</div><div class="value" style="color:var(--ok)">${money(d.monthProfit)}</div></div>
      <div class="card stat"><div class="label">Inventario (a costo)</div><div class="value">${money(d.inventoryCost)}</div></div></div>
    <div class="card"><h2>Ventas de los últimos 30 días</h2><div class="bars" style="height:150px">${Object.entries(d.daily).map(([k, v]) => `<div class="bar" title="${esc(fmtDay(k))}: ${money(v)}"><div style="height:${(v / max) * 100}%"></div><span>${Number(k.slice(8)) % 5 === 0 ? Number(k.slice(8)) : '&nbsp;'}</span></div>`).join('')}</div></div>
    <div class="grid cols-2">
      <div class="card"><h2>Por agotarse (${d.lowStock.length})</h2>${d.lowStock.length ? `<table>${d.lowStock.map(p => `<tr class="click" data-id="${p.id}"><td>${esc(p.name)}</td><td class="num stock-low">${qtyFmt(p.stock)} ${esc(p.unit)}</td><td class="num muted">mín. ${qtyFmt(p.minStock)}</td></tr>`).join('')}</table>` : '<p class="muted">Todo tu inventario está por encima del mínimo.</p>'}</div>
      <div class="card"><h2>Más vendidos del mes</h2>${d.top.length ? `<table>${d.top.map(t => `<tr><td>${esc(t.name)}</td><td class="num muted">${qtyFmt(t.qty)}</td><td class="num">${money(t.total)}</td></tr>`).join('')}</table>` : '<p class="muted">Sin ventas este mes.</p>'}</div></div>
    ${Object.keys(d.byMethodToday).length ? `<div class="card"><h2>Cierre de caja de hoy</h2><table>${Object.entries(d.byMethodToday).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${money(v)}</td></tr>`).join('')}<tr><td><strong>Total</strong></td><td class="num"><strong>${money(d.todayTotal)}</strong></td></tr></table></div>` : ''}`);
  document.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => { location.hash = '#/producto/' + tr.dataset.id; });
}

// ---------- Ajustes ----------
async function viewSettings() {
  const s = settings = await api('/api/settings');
  const f = (name, label, attrs = '') => `<div class="field"><label>${label}</label><input name="${name}" value="${esc(s[name])}" ${attrs}></div>`;
  shell('ajustes', `<h1>Ajustes</h1>
    <form id="f" class="card"><h2>Tu tienda</h2><div class="grid cols-2">
      ${f('businessName', 'Nombre de la tienda', 'required')}${f('taxId', 'NIT / RUT')}${f('address', 'Dirección')}${f('phone', 'Teléfono')}</div>
      <h2 style="margin-top:1rem">Ventas</h2><div class="grid cols-2">
      <div class="field"><label>Métodos de pago (separados por coma)</label><input name="paymentMethods" value="${esc(s.paymentMethods.join(', '))}"></div>
      ${f('receiptFooter', 'Mensaje al final del comprobante')}
      ${f('nextSale', 'Siguiente número de venta', 'type="number" min="1"')}
      <div class="field"><label>Moneda</label><select name="currency">${['COP', 'MXN', 'USD', 'EUR', 'PEN', 'CLP', 'ARS', 'GTQ', 'DOP', 'CRC', 'BOB', 'UYU', 'PYG'].map(c => `<option ${c === s.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Zona horaria</label><select name="timezone">${['America/Bogota', 'America/Mexico_City', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Caracas', 'America/Guayaquil', 'America/Panama', 'America/Santo_Domingo', 'America/Guatemala', 'America/Costa_Rica', 'America/Montevideo', 'America/Asuncion', 'America/La_Paz', 'America/New_York', 'Europe/Madrid'].map(v => `<option ${v === s.timezone ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
      <label style="display:flex;gap:.5rem;align-items:center;color:var(--text);margin-bottom:.75rem"><input type="checkbox" name="allowNegative" ${s.allowNegative ? 'checked' : ''} style="width:auto"> Permitir vender aunque el sistema diga que no hay stock</label>
      <p class="muted" style="font-size:.85rem">El comprobante que imprime la app no es factura electrónica. Si tu negocio está obligado a facturar electrónicamente, usa un proveedor autorizado por la DIAN (o la autoridad de tu país).</p>
      <button class="btn primary">Guardar ajustes</button></form>
    <form id="pw" class="card"><h2>Cambiar contraseña</h2><div class="grid cols-2">
      <div class="field"><label>Contraseña actual</label><input name="current" type="password" required autocomplete="current-password"></div>
      <div class="field"><label>Nueva contraseña</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div></div>
      <button class="btn">Actualizar contraseña</button></form>
    <div class="card"><h2>Copia de seguridad</h2><p class="muted">Descarga productos, ventas y movimientos. Hazlo seguido y antes de actualizar.</p>
      <div class="row"><a class="btn" href="/api/backup">Descargar copia</a>
      <label class="btn" style="margin:0;color:var(--text)">Restaurar desde archivo…<input type="file" id="restore" accept="application/json,.json" hidden></label></div></div>`);
  document.getElementById('f').onsubmit = async e => {
    e.preventDefault();
    try { settings = await api('/api/settings', { method: 'PUT', body: { ...formData(e.target), allowNegative: e.target.allowNegative.checked } }); payMethod = null; toast('Ajustes guardados'); } catch (err) { toast(err.message); }
  };
  document.getElementById('pw').onsubmit = async e => { e.preventDefault(); try { await api('/api/password', { method: 'PUT', body: formData(e.target) }); e.target.reset(); toast('Contraseña actualizada'); } catch (err) { toast(err.message); } };
  document.getElementById('restore').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('Esto reemplazará productos, ventas y movimientos por los del archivo. Se guardará una copia del estado actual en el servidor. ¿Continuar?')) { e.target.value = ''; return; }
    try { const r = await api('/api/restore', { method: 'POST', body: JSON.parse(await file.text()) }); toast(`Restaurado: ${r.products} productos, ${r.sales} ventas`); settings = null; setTimeout(route, 800); }
    catch (err) { toast(err.message.includes('JSON') ? 'El archivo no es válido' : err.message); e.target.value = ''; }
  };
}

// ---------- Router ----------
async function route() {
  const st = await fetch('/api/status').then(r => r.json());
  if (st.setup) return viewSetup();
  if (!st.authed) return viewLogin();
  const h = location.hash.slice(1) || '/';
  if (h === '/login') { location.hash = '#/'; return; }
  try {
    if (!settings) settings = await api('/api/settings');
    if (!todayStr) todayStr = (await api('/api/dashboard')).today;
    let m;
    if (h === '/') return await viewPOS();
    if (h === '/productos') return await viewProducts();
    if ((m = h.match(/^\/producto\/([a-f0-9]+)$/))) return await viewProduct(m[1]);
    if (h === '/ventas') return await viewSales();
    if ((m = h.match(/^\/ventas\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/))) return await viewSales(m[1], m[2]);
    if (h === '/resumen') return await viewSummary();
    if (h === '/ajustes') return await viewSettings();
    location.hash = '#/';
  } catch (err) { if (err.status !== 401) toast(err.message); }
}
window.addEventListener('hashchange', route);
route();
