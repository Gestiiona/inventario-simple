// InventarioSimple — inventario y punto de venta para tiendas pequeñas. Sin dependencias (Node.js >= 18)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Base de datos en archivo JSON ----------
const EMPTY_DB = {
  settings: {
    businessName: 'Mi Tienda',
    taxId: '',
    address: '',
    phone: '',
    currency: 'COP',
    locale: 'es-CO',
    timezone: 'America/Bogota',
    allowNegative: false,
    receiptFooter: '¡Gracias por tu compra!',
    paymentMethods: ['Efectivo', 'Transferencia', 'Nequi', 'Daviplata', 'Tarjeta'],
    nextSale: 1
  },
  auth: null,
  products: [],
  sales: [],
  movements: []
};
let db;
function id() { return crypto.randomBytes(8).toString('hex'); }
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.settings = { ...EMPTY_DB.settings, ...db.settings };
    db.products ||= []; db.sales ||= []; db.movements ||= [];
  } catch { db = structuredClone(EMPTY_DB); saveDb(); }
}
function saveDb() { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, DB_FILE); }
loadDb();

// ---------- Autenticación ----------
function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.auth = { salt, hash: hashPassword(pw, salt), secret: crypto.randomBytes(32).toString('hex') };
  saveDb();
}
if (!db.auth && process.env.ADMIN_PASSWORD) {
  if (process.env.ADMIN_PASSWORD.length < 8) console.warn('ADMIN_PASSWORD debe tener al menos 8 caracteres; se ignora.');
  else setPassword(process.env.ADMIN_PASSWORD);
}
const SETUP_CODE = db.auth ? null : (process.env.SETUP_CODE || crypto.randomBytes(4).toString('hex'));
if (SETUP_CODE) {
  console.log('==============================================');
  console.log(' Código de configuración inicial: ' + SETUP_CODE);
  console.log(' (o define la variable ADMIN_PASSWORD)');
  console.log('==============================================');
}
const sign = v => crypto.createHmac('sha256', db.auth.secret).update(v).digest('hex');
function makeSession() { const p = String(Date.now() + 30 * 864e5); return p + '.' + sign(p); }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isAuthed(req) {
  if (!db.auth) return false;
  const [payload, sig] = String(parseCookies(req).is_session || '').split('.');
  if (!payload || !sig) return false;
  const exp = sign(payload);
  return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp)) && Number(payload) > Date.now();
}
function cookieHeader(req, value, maxAge = 30 * 86400) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `is_session=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}
const safeEqual = (a, b) => { a = String(a); b = String(b); return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); };
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress;
}
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter(t => now - t < windowMs);
  buckets.set(key, list);
  return list.length >= max;
}
const hit = key => buckets.get(key)?.push(Date.now());

// ---------- Utilidades ----------
function send(res, status, data, headers = {}) {
  const isText = typeof data === 'string';
  res.writeHead(status, { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(isText ? data : JSON.stringify(data));
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Cuerpo demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('JSON inválido')); } });
  });
}
const str = (v, max = 500) => String(v ?? '').slice(0, max).trim();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = n => Math.round(n * 100) / 100;
function localParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: db.settings.timezone || 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const today = () => localParts().date;
function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function csvCell(v) {
  const s = String(v ?? '');
  const formula = /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s);
  const out = formula ? "'" + s : s;
  return formula || /[",\n;]/.test(out) ? '"' + out.replace(/"/g, '""') + '"' : out;
}
const csv = rows => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');

function productFields(b, existing = {}) {
  return {
    name: 'name' in b ? str(b.name, 150) : existing.name,
    sku: 'sku' in b ? str(b.sku, 60) : (existing.sku || ''),
    category: 'category' in b ? str(b.category, 60) : (existing.category || ''),
    unit: 'unit' in b ? (str(b.unit, 20) || 'und') : (existing.unit || 'und'),
    price: 'price' in b ? round2(Math.max(0, num(b.price))) : (existing.price || 0),
    cost: 'cost' in b ? round2(Math.max(0, num(b.cost))) : (existing.cost || 0),
    minStock: 'minStock' in b ? Math.max(0, num(b.minStock)) : (existing.minStock || 0),
    active: 'active' in b ? !!b.active : (existing.active ?? true)
  };
}
function addMovement(product, qty, type, note, ref = '') {
  const lp = localParts();
  product.stock = round2((product.stock || 0) + qty);
  const m = { id: id(), productId: product.id, productName: product.name, qty: round2(qty), stockAfter: product.stock, type, note: str(note, 300), ref, date: lp.date, time: lp.time, createdAt: new Date().toISOString() };
  db.movements.push(m);
  return m;
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/status' && m === 'GET') return send(res, 200, { setup: !db.auth, authed: isAuthed(req) });
  if (p === '/api/setup' && m === 'POST') {
    if (db.auth) return send(res, 400, { error: 'Ya está configurado' });
    const ip = clientIp(req);
    if (limited('login:' + ip, 10, 15 * 60 * 1000)) return send(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
    const b = await readBody(req);
    if (!safeEqual(String(b.setupCode || '').trim(), SETUP_CODE)) { hit('login:' + ip); return send(res, 401, { error: 'Código de configuración incorrecto. Búscalo en los registros (logs) del servidor.' }); }
    if (!b.password || String(b.password).length < 8) return send(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres' });
    setPassword(String(b.password));
    if (b.businessName) { db.settings.businessName = str(b.businessName, 200); saveDb(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, makeSession()) });
  }
  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (limited('login:' + ip, 10, 15 * 60 * 1000)) return send(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
    const b = await readBody(req);
    if (!db.auth) return send(res, 400, { error: 'Primero configura la app' });
    if (!safeEqual(hashPassword(String(b.password || ''), db.auth.salt), db.auth.hash)) { hit('login:' + ip); return send(res, 401, { error: 'Contraseña incorrecta' }); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, makeSession()) });
  }
  if (p === '/api/logout' && m === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) });

  if (!isAuthed(req)) return send(res, 401, { error: 'No autorizado' });

  // Ajustes
  if (p === '/api/settings' && m === 'GET') return send(res, 200, db.settings);
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req), s = db.settings;
    for (const k of ['businessName', 'taxId', 'address', 'phone', 'currency', 'locale', 'receiptFooter']) if (k in b) s[k] = str(b[k], 1000);
    if ('allowNegative' in b) s.allowNegative = !!b.allowNegative;
    if ('timezone' in b) { try { new Intl.DateTimeFormat('en', { timeZone: String(b.timezone) }); s.timezone = String(b.timezone); } catch { return send(res, 400, { error: 'Zona horaria no válida' }); } }
    if ('paymentMethods' in b) { const pm = String(b.paymentMethods).split(',').map(x => str(x, 40)).filter(Boolean).slice(0, 15); if (pm.length) s.paymentMethods = pm; }
    if ('nextSale' in b) s.nextSale = Math.max(1, Math.floor(num(b.nextSale)));
    saveDb(); return send(res, 200, s);
  }
  if (p === '/api/password' && m === 'PUT') {
    const b = await readBody(req);
    if (!safeEqual(hashPassword(String(b.current || ''), db.auth.salt), db.auth.hash)) return send(res, 400, { error: 'La contraseña actual no es correcta' });
    if (!b.password || String(b.password).length < 8) return send(res, 400, { error: 'Mínimo 8 caracteres' });
    setPassword(String(b.password));
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, makeSession()) });
  }

  // Productos
  if (p === '/api/products' && m === 'GET') return send(res, 200, db.products);
  if (p === '/api/products' && m === 'POST') {
    const b = await readBody(req);
    const f = productFields(b);
    if (!f.name) return send(res, 400, { error: 'El nombre es obligatorio' });
    if (f.sku && db.products.some(x => x.sku && x.sku.toLowerCase() === f.sku.toLowerCase())) return send(res, 400, { error: 'Ya existe un producto con ese código' });
    const pr = { id: id(), ...f, stock: 0, createdAt: new Date().toISOString() };
    db.products.push(pr);
    if (num(b.initialStock) > 0) addMovement(pr, num(b.initialStock), 'inicial', 'Inventario inicial');
    saveDb(); return send(res, 201, pr);
  }
  if (p === '/api/products.csv' && m === 'GET') {
    const rows = [['Código', 'Producto', 'Categoría', 'Unidad', 'Precio', 'Costo', 'Stock', 'Stock mínimo', 'Valor en costo'], ...db.products.map(x => [x.sku, x.name, x.category, x.unit, x.price, x.cost, x.stock, x.minStock, round2(x.stock * x.cost)])];
    return send(res, 200, csv(rows), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="productos-${today()}.csv"` });
  }
  let mt = p.match(/^\/api\/products\/([a-f0-9]+)$/);
  if (mt) {
    const pr = db.products.find(x => x.id === mt[1]);
    if (!pr) return send(res, 404, { error: 'Producto no encontrado' });
    if (m === 'GET') return send(res, 200, { ...pr, movements: db.movements.filter(x => x.productId === pr.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200) });
    if (m === 'PUT') {
      const f = productFields(await readBody(req), pr);
      if (!f.name) return send(res, 400, { error: 'El nombre es obligatorio' });
      if (f.sku && db.products.some(x => x.id !== pr.id && x.sku && x.sku.toLowerCase() === f.sku.toLowerCase())) return send(res, 400, { error: 'Ya existe un producto con ese código' });
      Object.assign(pr, f); saveDb(); return send(res, 200, pr);
    }
    if (m === 'DELETE') {
      if (db.sales.some(s => s.items.some(i => i.productId === pr.id))) {
        pr.active = false; saveDb();
        return send(res, 200, { ok: true, archived: true });
      }
      db.products = db.products.filter(x => x.id !== pr.id);
      db.movements = db.movements.filter(x => x.productId !== pr.id);
      saveDb(); return send(res, 200, { ok: true });
    }
  }

  // Movimientos de inventario: compras (entradas) y ajustes
  if (p === '/api/movements' && m === 'POST') {
    const b = await readBody(req);
    const pr = db.products.find(x => x.id === b.productId);
    if (!pr) return send(res, 404, { error: 'Producto no encontrado' });
    const type = ['entrada', 'ajuste', 'conteo'].includes(b.type) ? b.type : null;
    if (!type) return send(res, 400, { error: 'Tipo de movimiento inválido' });
    let qty = num(b.qty);
    if (type === 'entrada') {
      if (qty <= 0) return send(res, 400, { error: 'La cantidad debe ser mayor que cero' });
      // Costo promedio ponderado si se informa el costo de la compra
      if (num(b.unitCost) > 0) {
        const prev = Math.max(0, pr.stock);
        pr.cost = round2(prev + qty > 0 ? (prev * pr.cost + qty * num(b.unitCost)) / (prev + qty) : num(b.unitCost));
      }
    } else if (type === 'conteo') {
      qty = round2(num(b.qty) - pr.stock); // b.qty = cantidad contada físicamente
      if (qty === 0) return send(res, 200, { ...pr, unchanged: true });
    } else if (qty === 0) return send(res, 400, { error: 'La cantidad no puede ser cero' });
    const mv = addMovement(pr, qty, type, b.note || (type === 'conteo' ? `Conteo físico: ${num(b.qty)}` : ''));
    saveDb(); return send(res, 201, { product: pr, movement: mv });
  }
  if (p === '/api/movements' && m === 'GET') {
    const from = url.searchParams.get('from') || '0000', to = url.searchParams.get('to') || '9999';
    return send(res, 200, db.movements.filter(x => x.date >= from && x.date <= to).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1000));
  }

  // Ventas
  if (p === '/api/sales' && m === 'POST') {
    const b = await readBody(req);
    const items = Array.isArray(b.items) ? b.items.slice(0, 300) : [];
    if (!items.length) return send(res, 400, { error: 'Agrega al menos un producto' });
    const lines = [];
    for (const it of items) {
      const pr = db.products.find(x => x.id === it.productId);
      if (!pr) return send(res, 400, { error: 'Un producto del carrito ya no existe' });
      const qty = round2(num(it.qty));
      if (qty <= 0) return send(res, 400, { error: `Cantidad inválida para ${pr.name}` });
      const price = 'price' in it ? round2(Math.max(0, num(it.price))) : pr.price;
      lines.push({ pr, qty, price });
    }
    if (!db.settings.allowNegative) {
      const need = {};
      lines.forEach(l => { need[l.pr.id] = (need[l.pr.id] || 0) + l.qty; });
      for (const l of lines) if (need[l.pr.id] > l.pr.stock) return send(res, 409, { error: `No hay suficiente stock de ${l.pr.name} (quedan ${l.pr.stock})` });
    }
    const subtotal = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
    const discount = round2(Math.min(subtotal, Math.max(0, num(b.discount))));
    const total = round2(subtotal - discount);
    const method = db.settings.paymentMethods.includes(b.method) ? b.method : db.settings.paymentMethods[0];
    const received = round2(num(b.received));
    if (method === 'Efectivo' && received && received < total) return send(res, 400, { error: 'El efectivo recibido es menor que el total' });
    const lp = localParts();
    const number = String(db.settings.nextSale++).padStart(5, '0');
    const sale = {
      id: id(), number, date: lp.date, time: lp.time, createdAt: new Date().toISOString(),
      items: lines.map(l => ({ productId: l.pr.id, name: l.pr.name, sku: l.pr.sku, unit: l.pr.unit, qty: l.qty, price: l.price, cost: l.pr.cost, total: round2(l.qty * l.price) })),
      subtotal, discount, total, method, received: method === 'Efectivo' ? received : 0, change: method === 'Efectivo' && received ? round2(received - total) : 0,
      customer: str(b.customer, 120), status: 'ok'
    };
    lines.forEach(l => addMovement(l.pr, -l.qty, 'venta', '', 'Venta ' + number));
    db.sales.push(sale); saveDb();
    return send(res, 201, sale);
  }
  if (p === '/api/sales' && m === 'GET') {
    const from = url.searchParams.get('from') || '0000', to = url.searchParams.get('to') || '9999';
    return send(res, 200, db.sales.filter(s => s.date >= from && s.date <= to).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  if (p === '/api/sales.csv' && m === 'GET') {
    const from = url.searchParams.get('from') || '0000', to = url.searchParams.get('to') || '9999';
    const rows = [['Venta', 'Fecha', 'Hora', 'Estado', 'Método', 'Cliente', 'Código', 'Producto', 'Cantidad', 'Precio', 'Total línea', 'Costo línea']];
    db.sales.filter(s => s.date >= from && s.date <= to).forEach(s => s.items.forEach(i => rows.push([s.number, s.date, s.time, s.status === 'anulada' ? 'Anulada' : 'OK', s.method, s.customer, i.sku, i.name, i.qty, i.price, i.total, round2(i.qty * i.cost)])));
    return send(res, 200, csv(rows), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ventas-${from}-${to}.csv"` });
  }
  mt = p.match(/^\/api\/sales\/([a-f0-9]+)(\/void)?$/);
  if (mt) {
    const s = db.sales.find(x => x.id === mt[1]);
    if (!s) return send(res, 404, { error: 'Venta no encontrada' });
    if (!mt[2] && m === 'GET') return send(res, 200, s);
    if (mt[2] && m === 'POST') {
      if (s.status === 'anulada') return send(res, 400, { error: 'La venta ya está anulada' });
      const b = await readBody(req);
      s.status = 'anulada'; s.voidReason = str(b.reason, 200); s.voidedAt = new Date().toISOString();
      s.items.forEach(i => { const pr = db.products.find(x => x.id === i.productId); if (pr) addMovement(pr, i.qty, 'anulacion', s.voidReason, 'Venta ' + s.number); });
      saveDb(); return send(res, 200, s);
    }
  }

  // Resumen
  if (p === '/api/dashboard' && m === 'GET') {
    const t = today(), month = t.slice(0, 7);
    const ok = db.sales.filter(s => s.status === 'ok');
    const sum = (arr, f) => round2(arr.reduce((a, x) => a + f(x), 0));
    const profit = s => s.total - s.items.reduce((a, i) => a + i.qty * i.cost, 0);
    const daily = {};
    for (let i = 29; i >= 0; i--) daily[addDays(t, -i)] = 0;
    ok.forEach(s => { if (s.date in daily) daily[s.date] += s.total; });
    const todaySales = ok.filter(s => s.date === t), monthSales = ok.filter(s => s.date.startsWith(month));
    const byMethodToday = {};
    todaySales.forEach(s => { byMethodToday[s.method] = round2((byMethodToday[s.method] || 0) + s.total); });
    const top = {};
    monthSales.forEach(s => s.items.forEach(i => { top[i.name] ||= { qty: 0, total: 0 }; top[i.name].qty += i.qty; top[i.name].total += i.total - (s.discount ? i.total * s.discount / s.subtotal : 0); }));
    const active = db.products.filter(x => x.active);
    return send(res, 200, {
      today: t,
      todayTotal: sum(todaySales, s => s.total), todayCount: todaySales.length, byMethodToday,
      monthTotal: sum(monthSales, s => s.total), monthProfit: sum(monthSales, profit), monthCount: monthSales.length,
      inventoryCost: sum(active, x => Math.max(0, x.stock) * x.cost), inventoryRetail: sum(active, x => Math.max(0, x.stock) * x.price),
      lowStock: active.filter(x => x.stock <= x.minStock).sort((a, b) => a.stock - b.stock).slice(0, 30),
      top: Object.entries(top).map(([name, v]) => ({ name, qty: round2(v.qty), total: round2(v.total) })).sort((a, b) => b.total - a.total).slice(0, 8),
      daily
    });
  }

  if (p === '/api/backup' && m === 'GET') {
    const { auth, ...data } = db;
    return send(res, 200, data, { 'Content-Disposition': `attachment; filename="inventariosimple-${today()}.json"` });
  }
  if (p === '/api/restore' && m === 'POST') {
    const b = await readBody(req, 50e6);
    if (!b || typeof b.settings !== 'object' || !Array.isArray(b.products) || !Array.isArray(b.sales)) return send(res, 400, { error: 'El archivo no es una copia de seguridad válida' });
    fs.writeFileSync(path.join(DATA_DIR, `antes-de-restaurar-${Date.now()}.json`), JSON.stringify(db));
    db.settings = { ...EMPTY_DB.settings, ...b.settings };
    db.products = b.products; db.sales = b.sales; db.movements = Array.isArray(b.movements) ? b.movements : [];
    saveDb();
    return send(res, 200, { ok: true, products: db.products.length, sales: db.sales.length });
  }
  return send(res, 404, { error: 'Ruta no encontrada' });
}

// ---------- Archivos estáticos ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Prohibido'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'Se esperaba JSON' });
      return await api(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: e.message || 'Error' });
  }
}).listen(PORT, () => console.log(`InventarioSimple escuchando en http://localhost:${PORT}`));
