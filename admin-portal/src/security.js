import crypto from "crypto";
import { cfg } from "./config.js";

export const fp = (o) => crypto.createHmac("sha256", cfg.key).update(o).digest("hex");
export const enc = (t) => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", cfg.key, iv);
  const d = Buffer.concat([c.update(t, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), d].map((b) => b.toString("base64")).join(".");
};
export const dec = (s) => {
  const [iv, tag, d] = s.split(".").map((x) => Buffer.from(x, "base64"));
  const c = crypto.createDecipheriv("aes-256-gcm", cfg.key, iv);
  c.setAuthTag(tag);
  return Buffer.concat([c.update(d), c.final()]).toString("utf8");
};
export const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export function checkPassword(pw) {
  try {
    const [, salt, h] = cfg.passwordHash.split("$");
    return safeEq(crypto.scryptSync(pw, salt, 64).toString("hex"), h);
  } catch { return false; }
}

// ---- OTP: cryptographically secure, 6 digits, never an obvious pattern ----
const weak = (o) =>
  /^(\d)\1{5}$/.test(o) || "0123456789".includes(o) || "9876543210".includes(o) || /^(\d\d)\1\1$/.test(o) || /^(\d\d\d)\1$/.test(o);
export function newOtp() {
  for (;;) { const o = String(crypto.randomInt(100000, 1000000)); if (!weak(o)) return o; }
}

// ---- Session token (HS256 JWT, built on node:crypto) ----
const b64 = (x) => Buffer.from(x).toString("base64url");
const sig = (data) => crypto.createHmac("sha256", cfg.jwtSecret).update(data).digest("base64url");
export function signToken(sub, minutes) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." + b64(JSON.stringify({ sub, iat: now, exp: now + minutes * 60 }));
  return body + "." + sig(body);
}
export function verifyToken(t) {
  const p = String(t || "").split(".");
  if (p.length !== 3 || !safeEq(sig(p[0] + "." + p[1]), p[2])) return null;
  try {
    const pl = JSON.parse(Buffer.from(p[1], "base64url").toString());
    return pl.exp > Date.now() / 1000 ? pl : null;
  } catch { return null; }
}
