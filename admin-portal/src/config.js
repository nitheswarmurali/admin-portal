// Admin portal configuration. Reads .env (tiny built-in loader, no dependency) and validates it.
// If something is missing the portal switches itself OFF with a clear message - your shop website keeps running.
import fs from "fs";

try {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch { /* no .env file: fine on hosts that set real environment variables */ }

const E = process.env;
export const PROD = E.NODE_ENV === "production";
export const norm10 = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
};

export const problems = [];
for (const k of ["JWT_SECRET", "OTP_ENC_KEY", "OWNER_PHONE", "ADMIN_PASSWORD_HASH"]) if (!E[k]) problems.push("Missing " + k);
if (E.JWT_SECRET && E.JWT_SECRET.length < 32) problems.push("JWT_SECRET must be at least 32 characters");
if (E.OTP_ENC_KEY && !/^[0-9a-f]{64}$/i.test(E.OTP_ENC_KEY)) problems.push("OTP_ENC_KEY must be 64 hex characters");
if (E.ADMIN_PASSWORD_HASH && E.ADMIN_PASSWORD_HASH.split("$").length !== 3) problems.push("ADMIN_PASSWORD_HASH is not in scrypt$salt$hash format (run: npm run hash -- \"your password\")");

if (E.BRIDGE_SECRET && E.BRIDGE_SECRET.length < 32) problems.push("BRIDGE_SECRET must be at least 32 characters");

export const cfg = {
  ownerPhone: norm10(E.OWNER_PHONE),
  passwordHash: E.ADMIN_PASSWORD_HASH || "",
  jwtSecret: E.JWT_SECRET || "",
  key: Buffer.from(/^[0-9a-f]{64}$/i.test(E.OTP_ENC_KEY || "") ? E.OTP_ENC_KEY : "00".repeat(32), "hex"),
  sessionMin: Math.min(Math.max(+E.SESSION_MINUTES || 30, 5), 720),
  otpTtlMs: 10 * 60e3,
  maxAttempts: 5,
  provider: (E.SMS_PROVIDER || "console").toLowerCase(),
  supabase: !!(E.SUPABASE_URL && E.SUPABASE_SERVICE_KEY),
  bridgeSecret: E.BRIDGE_SECRET || "",             // shared secret with the customer portal
  port: +E.PORT || 4000,
  otpDb: E.OTP_DB_PATH || "./data/otp.json",
  trustProxy: E.TRUST_PROXY !== undefined ? +E.TRUST_PROXY || 0 : PROD ? 1 : 0,
};
