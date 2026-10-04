const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const fmt = (d) => d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
const API = '/admin-api';
let cur = null, tick = null, range = 'today', ofilter = 'all', ORDERS = [], COUNTS = {}, ME = null, es = null, poll = null, seen = null, fresh = new Set(), unread = 0, actx = null;

function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 3200); }
async function api(p, body) {
  const r = await fetch(API + p, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && p !== '/auth/login') { showLogin(); throw new Error('Session ended. Sign in again.'); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
const busy = async (b, f) => { b.disabled = true; try { await f(); } catch (e) { toast(e.message); } finally { b.disabled = false; } };
const pill = (s) => el('span', 'pill ' + s, s);
function beep() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain(); o.connect(g); g.connect(actx.destination); o.frequency.value = 880; g.gain.setValueAtTime(.15, actx.currentTime); g.gain.exponentialRampToValueAtTime(.001, actx.currentTime + .45); o.start(); o.stop(actx.currentTime + .45); } catch { } }

// ---------- session ----------
function showLogin() { stopLive(); $('#app').hidden = true; $('#login').hidden = false; }
async function boot() {
  try { ME = await api('/auth/me'); $('#login').hidden = true; $('#app').hidden = false; route(); startLive(); }
  catch (e) { showLogin(); if (e.message && !/sign in/i.test(e.message)) $('#le').textContent = e.message; }
}
$('#loginForm').onsubmit = (e) => { e.preventDefault(); $('#le').textContent = ''; try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); } catch { }
  busy(e.submitter, async () => { try { await api('/auth/login', { phone: $('#lp').value.trim(), password: $('#lw').value }); $('#lw').value = ''; seen = null; boot(); } catch (x) { $('#le').textContent = x.message; } }); };
$('#logout').onclick = (e) => busy(e.target, async () => { await api('/auth/logout', {}); showLogin(); });

// ---------- navigation ----------
function route() {
  const id = (location.hash || '#dashboard').slice(1), s = $('#' + id) ? id : 'dashboard';
  $$('section').forEach((x) => x.classList.toggle('on', x.id === s)); $$('#nav a').forEach((a) => a.classList.toggle('on', a.hash === '#' + s));
  if (s === 'orders') { unread = 0; fresh.clear(); badge(); }
  ({ dashboard: loadDash, orders: loadOrders, history: loadHist, settings: loadSettings, generate: loadGen }[s] || (async () => { }))().catch((e) => toast(e.message));
}
addEventListener('hashchange', route);
function badge() { const b = $('#nbadge'); b.hidden = !unread; b.textContent = unread; document.title = (unread ? `(${unread}) ` : '') + 'Hemalatha Vegetables · Owner Portal'; }

// ---------- live orders ----------
function startLive() {
  stopLive();
  try { es = new EventSource(API + '/orders/stream'); es.addEventListener('orders', () => loadOrders().catch(() => { })); es.onopen = () => $('#live').classList.add('on'); es.onerror = () => $('#live').classList.remove('on'); } catch { }
  poll = setInterval(() => { if (!document.hidden && !$('#app').hidden) loadOrders().catch(() => { }); }, 15000); // safety net if the live stream is blocked
  loadOrders().catch(() => { });
}
function stopLive() { if (es) es.close(); es = null; clearInterval(poll); $('#live').classList.remove('on'); }

async function loadOrders() {
  const d = await api('/orders?limit=100'); ORDERS = d.orders; COUNTS = d.counts;
  const ids = new Set(ORDERS.map((o) => o.orderId));
  if (seen) { const added = ORDERS.filter((o) => !seen.has(o.orderId)); if (added.length) { added.forEach((o) => fresh.add(o.orderId)); unread += added.length; badge(); beep(); toast('🛒 New order from ' + (added[0].name || 'a customer')); } }
  seen = ids;
  renderOrders(); renderDash();
}
function orderCard(o, small) {
  const d = el('div', 'o' + (fresh.has(o.orderId) ? ' fresh' : '')), top = el('div', 'top'), l = el('div');
  l.append(el('b', 0, o.name || 'Customer'), el('small', 0, o.phone + ' · ' + fmt(o.createdAt)));
  const pills = el('div', 'pills'); pills.append(pill(o.status === 'completed' ? 'completed' : 'active')); if (o.otp) pills.append(pill('OTP ' + o.otp.status));
  top.append(l, pills); d.append(top);
  if (small) return d;
  d.append(el('small', 0, o.address || 'No address'));
  const det = el('details'); det.append(el('summary', 0, 'Order ' + o.orderId));
  const inner = el('div'); inner.append(el('pre', 0, 'Delivery code: ' + o.code + (o.completedAt ? '\nDelivered: ' + fmt(o.completedAt) : '') + (o.total ? '\nTotal: ' + o.total : '') + (o.details ? '\n\n' + o.details : ''))); det.append(inner); d.append(det);
  const acts = el('div', 'acts'), otp = el('button', 'btn sm', 'Send OTP'); otp.onclick = () => { $('#gp').value = o.phone10; location.hash = '#generate'; $('#gout').hidden = true; };
  const call = el('a', 'btn sm alt', 'Call'); call.href = 'tel:' + o.phone10;
  acts.append(otp, call); d.append(acts); return d;
}
function renderOrders() {
  const rows = ORDERS.filter((o) => ofilter === 'all' || (ofilter === 'completed' ? o.status === 'completed' : o.status !== 'completed'));
  $('#olist').replaceChildren(...(rows.length ? rows.map((o) => orderCard(o)) : [el('p', 'empty', 'No orders here yet. New orders from your website appear here instantly.')]));
}
$('#ochips').onclick = (e) => { const f = e.target.dataset.f; if (!f) return; ofilter = f; $$('#ochips button').forEach((b) => b.classList.toggle('on', b === e.target)); renderOrders(); };

// ---------- dashboard / history / settings ----------
async function loadDash() {
  const h = await api('/otp/history?range=today'), c = (k) => h.filter((r) => r.status === k).length;
  const stats = [['Orders today', COUNTS.today ?? '…'], ['Pending delivery', COUNTS.active ?? '…'], ['OTPs sent', h.filter((r) => r.sent_at).length], ['OTPs verified', c('verified')]];
  $('#stats').replaceChildren(...stats.map(([k, v]) => { const d = el('div', 'stat'); d.append(el('b', 0, v), el('span', 0, k)); return d; }));
  renderDash();
}
function renderDash() { const r = $('#recent'); r.replaceChildren(...(ORDERS.length ? ORDERS.slice(0, 6).map((o) => orderCard(o, true)) : [el('p', 'empty', 'No orders yet.')])); }

function otpRow(r) { const d = el('div'), l = el('div'); l.append(el('b', 0, r.customer_phone), el('small', 0, 'Created ' + fmt(r.created_at) + ' · Expires ' + fmt(r.expires_at) + (r.verified_at ? ' · Verified ' + fmt(r.verified_at) : '') + (r.attempt_count ? ' · ' + r.attempt_count + ' attempt(s)' : ''))); d.append(l, pill(r.status)); return d; }
async function loadHist() { const rows = await api('/otp/history?range=' + range); $('#hist').replaceChildren(...(rows.length ? rows.map(otpRow) : [el('p', 'empty', 'No OTPs in this period.')])); }
$('#chips').onclick = (e) => { const r = e.target.dataset.r; if (!r) return; range = r; $$('#chips button').forEach((b) => b.classList.toggle('on', b === e.target)); loadHist().catch((x) => toast(x.message)); };
async function loadSettings() {
  const m = await api('/auth/me'), c = $('#cfg');
  c.replaceChildren(...[['Signed in as', m.admin], ['SMS', m.smsNote], ['OTP validity', m.otpMinutes + ' minutes'], ['Wrong attempts allowed', m.maxAttempts], ['Session timeout', m.sessionMinutes + ' minutes of inactivity'], ['OTP storage', m.storage]].map(([k, v]) => { const p = el('p'); p.append(el('b', 0, k + ': '), document.createTextNode(v)); return p; }));
  const a = await api('/audit'), box = $('#audit');
  box.replaceChildren(...(a.length ? a.map((x) => { const d = el('div'), l = el('div'); l.append(el('b', 0, x.action.replace(/_/g, ' ')), el('small', 0, fmt(x.created_at) + ' · ' + (x.ip_address || ''))); d.append(l, el('small', 0, x.detail || '')); return d; }) : [el('p', 'empty', 'No activity yet.')]));
}

// ---------- OTP generate / send / verify ----------
async function loadGen() { const m = ME || await api('/auth/me'), t = $('#testmode'); t.hidden = m.smsLive; t.textContent = m.smsLive ? '' : '⚠ ' + m.smsNote; }
function showOtp(r) {
  cur = r; $('#gout').hidden = false; $('#digits').replaceChildren(...r.otp.split('').map((d) => el('span', 0, d)));
  clearInterval(tick);
  const upd = () => { const s = Math.round((new Date(r.expires_at) - Date.now()) / 1000);
    if (s <= 0) { clearInterval(tick); $('#gmeta').textContent = 'Expired. Generate a new OTP.'; $('#send').disabled = true; return; }
    $('#gmeta').textContent = `For ${r.customer_phone} · ${r.status === 'sent' ? 'SMS sent · ' : ''}valid for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  upd(); tick = setInterval(upd, 1000); $('#send').disabled = false;
}
$('#gen').onclick = (e) => busy(e.target, async () => { showOtp(await api('/otp/generate', { phone: $('#gp').value.trim() })); toast('OTP generated'); });
$('#send').onclick = (e) => busy(e.target, async () => { const r = await api('/otp/send', { id: cur.id }); showOtp({ ...cur, ...r }); toast(r.testMode ? 'Test mode: OTP printed in server console' : 'SMS sent to ' + r.customer_phone); });
$('#ver').onclick = (e) => busy(e.target, async () => {
  const v = $('#vr'); v.className = 'result'; v.textContent = '';
  try { await api('/otp/verify', { phone: $('#vp').value.trim(), otp: $('#vo').value.trim() }); v.className = 'result ok'; v.textContent = '✅ Verification Successful'; $('#vo').value = ''; loadOrders().catch(() => { }); }
  catch (x) { v.className = 'result no'; v.textContent = '❌ ' + x.message; }
});
['gp', 'vp', 'vo', 'lp'].forEach((i) => $('#' + i).addEventListener('input', (e) => e.target.value = e.target.value.replace(/\D/g, '')));

// ---------- theme ----------
let th = 'light'; try { th = localStorage.getItem('hv-theme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'); } catch { }
document.documentElement.dataset.theme = th;
$('#theme').onclick = () => { const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; try { localStorage.setItem('hv-theme', n); } catch { } };
boot();
