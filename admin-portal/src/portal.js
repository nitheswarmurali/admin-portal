// Hemalatha Vegetables - ADMIN PORTAL (standalone app).
//   UI : /admin     API : /admin-api/*     Order intake from the customer portal : POST /api/ingest (signed)
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { cfg, problems, PROD, norm10 } from "./config.js";
import * as sec from "./security.js";
import { createStore } from "./store.js";
import { sendSms, smsStatus } from "./sms.js";

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC = {
  "/admin/": ["admin.html", "text/html; charset=utf-8"],
  "/admin/admin.css": ["admin.css", "text/css; charset=utf-8"],
  "/admin/admin.js": ["admin.js", "application/javascript; charset=utf-8"],
};
const PHONE = /^[6-9]\d{9}$/, OTP6 = /^\d{6}$/, UUID = /^[0-9a-f-]{36}$/i, COOKIE = "hv_admin";

// ---------- startup ----------
let store = null, fatal = problems.length ? problems.join("; ") : null;
const ready = problems.length ? Promise.resolve() : Promise.resolve(createStore()).then((s) => { store = s; }).catch((e) => { fatal = "Storage failed to start: " + e.message; console.error("[admin]", fatal); });
if (fatal) console.warn("[admin] Admin portal is OFF: " + fatal);
if (!cfg.bridgeSecret) console.warn("[admin] BRIDGE_SECRET is not set: orders from the customer portal will be rejected.");
else ready.then(() => !fatal && console.log(`[admin] Owner portal ready at /admin  (storage: ${store.kind}, SMS: ${smsStatus().note})`));

// ---------- small helpers (no external packages) ----------
const send = (res, code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); };
const bad = (res, msg, code = 400) => send(res, code, { error: msg });
const secure = (res) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=15552000");
};
const clientIp = (req) => {
  if (cfg.trustProxy) {
    const x = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (x.length) return x[Math.max(0, x.length - cfg.trustProxy)];
  }
  return req.socket?.remoteAddress || "unknown";
};
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || "").split(";").map((c) => { const i = c.indexOf("="); return i < 0 ? ["", ""] : [c.slice(0, i).trim(), c.slice(i + 1).trim()]; }));
const setSession = (res, sub) =>
  res.setHeader("Set-Cookie", `${COOKIE}=${sec.signToken(sub, cfg.sessionMin)}; Path=/admin-api; HttpOnly; SameSite=Strict; Max-Age=${cfg.sessionMin * 60}${PROD ? "; Secure" : ""}`);
const clearSession = (res) => res.setHeader("Set-Cookie", `${COOKIE}=; Path=/admin-api; HttpOnly; SameSite=Strict; Max-Age=0${PROD ? "; Secure" : ""}`);

// rate limiting + brute-force lockout (in-memory; use a shared store like Redis if you ever run several servers)
const hits = new Map(), fails = new Map();
const limited = (key, max, ms) => { const n = Date.now(); let h = hits.get(key); if (!h || n > h.reset) { h = { n: 0, reset: n + ms }; hits.set(key, h); } return ++h.n > max; };
const locked = (k) => { const f = fails.get(k); return f && f.n >= 5 && Date.now() < f.until; };
const addFail = (k) => { const f = fails.get(k); const n = Date.now(); const cur = f && n < f.until ? f : { n: 0 }; cur.n++; cur.until = n + 15 * 60e3; fails.set(k, cur); };
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); for (const [k, v] of fails) if (n > v.until) fails.delete(k); }, 10 * 60e3).unref();

const audit = (c, action, detail = "", actor) => store.audit({ actor: actor || c.admin?.sub || "anonymous", action, detail, ip_address: c.ip }).catch((e) => console.error("[admin] audit:", e.message));
const pub = (r) => ({ id: r.id, customer_phone: r.customer_phone, status: r.status, created_at: r.created_at, expires_at: r.expires_at, sent_at: r.sent_at, verified_at: r.verified_at, verified: r.verified, attempt_count: r.attempt_count, send_count: r.send_count, generated_by: r.generated_by });

const IST = 19800e3;
const istDayStart = () => Math.floor((Date.now() + IST) / 864e5) * 864e5 - IST;

// ---------- orders (received live from the customer portal) ----------
const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : v == null ? "" : String(v).slice(0, n));
const orderView = (o, otpByPhone) => {
  const ph = norm10(o.phone), last = otpByPhone.get(ph);
  return {
    orderId: s(o.orderId, 40), code: s(o.code, 30), status: s(o.status, 20), createdAt: o.createdAt, completedAt: o.completedAt || null,
    name: s(o.name, 80), phone: s(o.phone, 20), phone10: ph, address: s(o.address, 200),
    details: typeof o.body === "string" ? o.body.slice(0, 4000) : null, total: o.total != null ? s(o.total, 20) : null,
    otp: last ? { status: last.status, at: last.created_at } : null,
  };
};

// ---------- live stream (Server-Sent Events): pings the portal the moment db.json changes ----------
const streams = new Set();
const broadcast = () => { for (const r of streams) r.write(`event: orders\ndata: ${Date.now()}\n\n`); };

// ---------- API routes ----------
const R = {};
R["POST /auth/login"] = [false, async (c) => {
  const { phone, password } = c.body || {};
  if (typeof phone !== "string" || typeof password !== "string" || password.length > 200 || phone.length > 20) return bad(c.res, "Invalid input");
  const ph = norm10(phone), k = c.ip + "|" + ph;
  if (locked(k) || locked(c.ip)) return bad(c.res, "Too many attempts. Try again in 15 minutes.", 429);
  const ok = sec.safeEq(ph, cfg.ownerPhone) & sec.checkPassword(password); // both always evaluated
  if (!ok) { addFail(k); addFail(c.ip); await audit(c, "login_failed", ph.slice(-4), "anonymous"); return bad(c.res, "Wrong mobile number or password.", 401); }
  fails.delete(k); c.admin = { sub: ph }; setSession(c.res, ph); await audit(c, "login");
  send(c.res, 200, { ok: true });
}];
R["POST /auth/logout"] = [true, async (c) => { await audit(c, "logout"); clearSession(c.res); send(c.res, 200, { ok: true }); }];
R["GET /auth/me"] = [true, async (c) => { const st = smsStatus(); send(c.res, 200, { admin: c.admin.sub, sessionMinutes: cfg.sessionMin, provider: st.provider, smsLive: st.live, smsNote: st.note, storage: store.kind, otpMinutes: cfg.otpTtlMs / 60e3, maxAttempts: cfg.maxAttempts }); }];

R["POST /otp/generate"] = [true, async (c) => {
  const phone = norm10(c.body?.phone);
  if (!PHONE.test(phone)) return bad(c.res, "Enter a valid 10-digit Indian mobile number.");
  await store.sweep();
  if ((await store.countSince(phone, new Date(Date.now() - 3600e3).toISOString())) >= 5) return bad(c.res, "Limit reached: 5 OTPs per hour for this number.", 429);
  await store.expireActive(phone); // one live OTP per customer
  for (let i = 0; i < 8; i++) {
    const otp = sec.newOtp();
    try {
      const row = await store.insert({ customer_phone: phone, otp: sec.enc(otp), otp_fp: sec.fp(otp), expires_at: new Date(Date.now() + cfg.otpTtlMs).toISOString(), generated_by: c.admin.sub, ip_address: c.ip });
      await audit(c, "otp_generated", phone);
      return send(c.res, 200, { ...pub(row), otp });
    } catch (e) { if (e.code === "23505") continue; throw e; } // same OTP already active for someone -> draw again
  }
  bad(c.res, "Could not generate a unique OTP. Try again.", 500);
}];

R["POST /otp/send"] = [true, async (c) => {
  const id = String(c.body?.id || "");
  const r = UUID.test(id) ? await store.get(id) : null;
  if (!r || !["pending", "sent"].includes(r.status) || new Date(r.expires_at) < new Date()) return bad(c.res, "This OTP has expired. Generate a new one.");
  if (r.send_count >= 3) return bad(c.res, "SMS limit reached for this OTP (3). Generate a new one.", 429);
  try { await sendSms(r.customer_phone, sec.dec(r.otp)); }
  catch (e) { console.error("[admin] SMS failed:", e.message); await audit(c, "sms_failed", r.customer_phone + " " + e.message.slice(0, 120)); return bad(c.res, "SMS could not be sent. " + e.message.slice(0, 160), 502); }
  const row = await store.update(r.id, { status: "sent", sent_at: new Date().toISOString(), send_count: r.send_count + 1 });
  await audit(c, "otp_sent", r.customer_phone);
  send(c.res, 200, { ...pub(row), testMode: !smsStatus().live });
}];

R["POST /otp/verify"] = [true, async (c) => {
  const phone = norm10(c.body?.phone), otp = String(c.body?.otp || "").trim();
  if (!PHONE.test(phone) || !OTP6.test(otp)) return bad(c.res, "Enter a 10-digit mobile number and a 6-digit OTP.");
  await store.sweep();
  const r = await store.active(phone);
  if (!r) return bad(c.res, "No active OTP for this number. It may have expired — generate a new one.");
  if (r.attempt_count >= cfg.maxAttempts) return bad(c.res, "Too many wrong attempts. Generate a new OTP.", 429);
  if (sec.safeEq(sec.fp(otp), r.otp_fp)) {
    await store.update(r.id, { verified: true, status: "verified", verified_at: new Date().toISOString(), attempt_count: r.attempt_count + 1 });
    await audit(c, "otp_verified", phone);
    return send(c.res, 200, { ok: true, message: "Verification Successful" });
  }
  const n = r.attempt_count + 1;
  await store.update(r.id, { attempt_count: n, ...(n >= cfg.maxAttempts ? { status: "failed" } : {}) });
  await audit(c, "otp_verify_failed", phone);
  bad(c.res, `Verification Failed. ${Math.max(cfg.maxAttempts - n, 0)} attempt(s) left.`);
}];

R["GET /otp/history"] = [true, async (c) => {
  await store.sweep();
  const d0 = istDayStart(), r = c.query.get("range");
  const from = r === "yesterday" ? d0 - 864e5 : r === "7d" ? d0 - 6 * 864e5 : r === "30d" ? d0 - 29 * 864e5 : d0;
  const rows = await store.history(new Date(from).toISOString(), r === "yesterday" ? new Date(d0).toISOString() : null, 300);
  send(c.res, 200, rows.map(pub));
}];

R["GET /orders"] = [true, async (c) => {
  const all = await store.listOrders(1000);
  await store.sweep();
  const otpByPhone = new Map();
  for (const r of await store.history(new Date(Date.now() - 30 * 864e5).toISOString(), null, 1000)) if (!otpByPhone.has(r.customer_phone)) otpByPhone.set(r.customer_phone, r); // newest first
  const d0 = istDayStart(), lim = Math.min(Math.max(+c.query.get("limit") || 100, 1), 500);
  const sorted = [...all].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  send(c.res, 200, {
    counts: { total: all.length, today: all.filter((o) => Date.parse(o.createdAt) >= d0).length, active: all.filter((o) => o.status === "active").length, completed: all.filter((o) => o.status === "completed").length },
    orders: sorted.slice(0, lim).map((o) => orderView(o, otpByPhone)),
  });
}];

R["GET /orders/stream"] = [true, async (c) => {
  const { req, res } = c;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 3000\n\n");
  streams.add(res);
  const beat = setInterval(() => res.write(": ping\n\n"), 20000);
  const end = setTimeout(() => res.end(), 4 * 60e3); // reconnect every 4 min so an expired session can never keep a stream open
  req.on("close", () => { clearInterval(beat); clearTimeout(end); streams.delete(res); });
}];

R["GET /audit"] = [true, async (c) => send(c.res, 200, await store.auditList(50))];

// ---------- order intake from the customer portal (server-to-server, HMAC-signed) ----------
const cleanOrder = (o) => {
  if (!o || typeof o !== "object" || !/^[\w-]{3,60}$/.test(String(o.orderId))) return null;
  const iso = (v) => (v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  return { orderId: String(o.orderId), code: s(o.code, 30), status: o.status === "completed" ? "completed" : "active",
    createdAt: iso(o.createdAt) || new Date().toISOString(), completedAt: iso(o.completedAt), name: s(o.name, 80), phone: s(o.phone, 20), address: s(o.address, 200),
    ...(o.body ? { body: s(o.body, 4000) } : {}), ...(o.total != null ? { total: s(o.total, 20) } : {}) };
};
async function ingest(req, res) {
  try {
    if (fatal) return bad(res, "Admin portal is not configured", 503);
    if (!cfg.bridgeSecret) return bad(res, "Order intake is not configured (BRIDGE_SECRET missing)", 503);
    if (limited("ingest|" + clientIp(req), 600, 60e3)) return bad(res, "Too many requests", 429);
    const ts = +req.headers["x-bridge-timestamp"], sg = String(req.headers["x-bridge-signature"] || "");
    if (!ts || Math.abs(Date.now() - ts) > 5 * 60e3) return bad(res, "Stale or missing timestamp", 401);
    const want = crypto.createHmac("sha256", cfg.bridgeSecret).update(ts + "." + (req.rawBody || "")).digest("hex");
    if (!sec.safeEq(sg, want)) return bad(res, "Bad signature", 401);
    const o = cleanOrder(req.body?.order);
    if (!o) return bad(res, "Invalid order", 400);
    await ready; if (fatal) return bad(res, "Admin portal is not configured", 503);
    await store.upsertOrder(o); broadcast();
    console.log(`[admin] order received: ${o.orderId} (${o.status})`);
    send(res, 200, { ok: true });
  } catch (e) { console.error("[admin] ingest:", e); if (!res.headersSent) bad(res, "Server error", 500); }
}

// ---------- the middleware ----------
export default function adminPortal(req, res, next) {
  const raw = req.originalUrl || req.url || "";
  if (raw.split("?")[0] === "/api/ingest" && req.method === "POST") return ingest(req, res);
  if (!raw.startsWith("/admin")) return next();
  const u = new URL(raw, "http://local"), p = u.pathname;

  if (p === "/admin") { res.statusCode = 302; res.setHeader("Location", "/admin/"); return res.end(); }
  if (STATIC[p] && req.method === "GET") {
    secure(res);
    try { const [f, t] = STATIC[p]; const b = fs.readFileSync(path.join(PUB, f)); res.setHeader("Content-Type", t); return res.end(b); }
    catch { res.statusCode = 404; return res.end("Not found"); }
  }
  if (!p.startsWith("/admin-api/")) return next();

  secure(res);
  if (fatal) return bad(res, "Admin portal is not configured: " + fatal, 503);
  const c = { req, res, ip: clientIp(req), query: u.searchParams, body: req.body && typeof req.body === "object" ? req.body : {} };
  const route = R[req.method + " " + p.slice("/admin-api".length)];
  if (!route) return bad(res, "Not found", 404);
  if (limited("api|" + c.ip, 120, 60e3)) return bad(res, "Too many requests. Slow down.", 429);
  // CSRF: cookie is SameSite=Strict AND every state-changing call must carry this custom header
  if (req.method !== "GET" && req.headers["x-requested-with"] !== "admin") return bad(res, "Forbidden", 403);

  ready.then(async () => {
    if (fatal) return bad(res, "Admin portal is not configured: " + fatal, 503);
    if (route[0]) {
      const t = sec.verifyToken(cookies(req)[COOKIE]);
      if (!t) return bad(res, "Please sign in again.", 401);
      c.admin = { sub: t.sub }; setSession(res, t.sub); // sliding session timeout
    }
    await route[1](c);
  }).catch((e) => { console.error("[admin]", e); if (!res.headersSent) bad(res, "Server error. Try again.", 500); });
}
