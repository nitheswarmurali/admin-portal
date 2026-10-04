// OTP + audit storage. Two interchangeable drivers:
//   file     -> data/otp.json (default, zero setup, same style as your existing db.json)
//   supabase -> used automatically when SUPABASE_URL + SUPABASE_SERVICE_KEY are set (run supabase/schema.sql once)
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { cfg } from "./config.js";

const ACTIVE = ["pending", "sent"];
const isActive = (r) => ACTIVE.includes(r.status);
const mergeOrder = (ex, inc) => (ex ? { ...ex, ...inc, createdAt: ex.createdAt || inc.createdAt, status: ex.status === "completed" ? "completed" : inc.status, completedAt: ex.completedAt || inc.completedAt } : inc);
const dupError = () => Object.assign(new Error("duplicate active otp"), { code: "23505" });

function fileStore(file) {
  const abs = path.resolve(file);
  let state = { otps: [], audit: [], orders: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(abs, "utf8")) }; }
  catch (e) {
    if (e.code !== "ENOENT") { try { fs.renameSync(abs, abs + ".corrupt-" + Date.now()); } catch {} console.error("[admin] otp.json was unreadable, moved aside:", e.message); }
  }
  const save = () => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs + ".tmp", JSON.stringify(state));
    fs.renameSync(abs + ".tmp", abs);          // atomic: never a half-written file
  };
  const copy = (r) => (r ? { ...r } : r);
  return {
    kind: "file",
    async sweep() {
      const now = Date.now(); let ch = false;
      for (const r of state.otps) if (isActive(r) && Date.parse(r.expires_at) < now) { r.status = "expired"; ch = true; }
      const keep = state.otps.filter((r) => Date.parse(r.created_at) > now - 90 * 864e5);
      if (keep.length !== state.otps.length) { state.otps = keep; ch = true; }
      if (ch) save();
    },
    async countSince(phone, iso) { return state.otps.filter((r) => r.customer_phone === phone && r.created_at > iso).length; },
    async expireActive(phone) { let ch = false; for (const r of state.otps) if (r.customer_phone === phone && isActive(r)) { r.status = "expired"; ch = true; } if (ch) save(); },
    async insert(row) {
      if (state.otps.some((r) => isActive(r) && r.otp_fp === row.otp_fp)) throw dupError();
      const rec = { id: crypto.randomUUID(), status: "pending", created_at: new Date().toISOString(), sent_at: null, verified_at: null, verified: false, attempt_count: 0, send_count: 0, ...row };
      state.otps.push(rec); save(); return copy(rec);
    },
    async get(id) { return copy(state.otps.find((r) => r.id === id)); },
    async update(id, patch) { const r = state.otps.find((x) => x.id === id); if (!r) return null; Object.assign(r, patch); save(); return copy(r); },
    async active(phone) {
      const now = Date.now();
      return copy(state.otps.filter((r) => r.customer_phone === phone && isActive(r) && Date.parse(r.expires_at) > now).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]);
    },
    async history(fromIso, toIso, limit) {
      return state.otps.filter((r) => r.created_at >= fromIso && (!toIso || r.created_at < toIso)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(copy);
    },
    async upsertOrder(o) {
      const i = state.orders.findIndex((x) => x.orderId === o.orderId), m = mergeOrder(state.orders[i], o);
      if (i >= 0) state.orders[i] = m; else state.orders.push(m);
      if (state.orders.length > 20000) state.orders = state.orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20000);
      save(); return { ...m };
    },
    async listOrders(limit) { return [...state.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((o) => ({ ...o })); },
    async audit(e) { state.audit.push({ id: state.audit.length ? state.audit[state.audit.length - 1].id + 1 : 1, created_at: new Date().toISOString(), ...e }); if (state.audit.length > 2000) state.audit = state.audit.slice(-2000); save(); },
    async auditList(n) { return state.audit.slice(-n).reverse(); },
  };
}

async function supabaseStore(url, key) {
  const { createClient } = await import("@supabase/supabase-js");   // only loaded if you use Supabase
  const db = createClient(url, key, { auth: { persistSession: false } });
  const run = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
  const nowIso = () => new Date().toISOString();
  return {
    kind: "supabase",
    sweep: () => run(db.from("otp_requests").update({ status: "expired" }).in("status", ACTIVE).lt("expires_at", nowIso())),
    async countSince(phone, iso) { const { count, error } = await db.from("otp_requests").select("id", { count: "exact", head: true }).eq("customer_phone", phone).gt("created_at", iso); if (error) throw error; return count || 0; },
    expireActive: (phone) => run(db.from("otp_requests").update({ status: "expired" }).eq("customer_phone", phone).in("status", ACTIVE)),
    insert: (row) => run(db.from("otp_requests").insert(row).select().single()),
    get: (id) => run(db.from("otp_requests").select("*").eq("id", id).maybeSingle()),
    update: (id, patch) => run(db.from("otp_requests").update(patch).eq("id", id).select().single()),
    async active(phone) { return (await run(db.from("otp_requests").select("*").eq("customer_phone", phone).in("status", ACTIVE).gt("expires_at", nowIso()).order("created_at", { ascending: false }).limit(1)))?.[0]; },
    async history(fromIso, toIso, limit) {
      let q = db.from("otp_requests").select("*").gte("created_at", fromIso).order("created_at", { ascending: false }).limit(limit);
      if (toIso) q = q.lt("created_at", toIso);
      return run(q);
    },
    async upsertOrder(o) {
      const ex = (await run(db.from("orders").select("data").eq("order_id", o.orderId).maybeSingle()))?.data, m = mergeOrder(ex, o);
      await run(db.from("orders").upsert({ order_id: m.orderId, status: m.status, created_at: m.createdAt, data: m }, { onConflict: "order_id" })); return m;
    },
    async listOrders(limit) { return (await run(db.from("orders").select("data").order("created_at", { ascending: false }).limit(limit))).map((r) => r.data); },
    audit: (e) => run(db.from("audit_logs").insert(e)),
    async auditList(n) { return (await run(db.from("audit_logs").select("created_at,action,detail,ip_address").order("created_at", { ascending: false }).limit(n))) || []; },
  };
}

export const createStore = () => (cfg.supabase ? supabaseStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : fileStore(cfg.otpDb));
