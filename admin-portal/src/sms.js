import { cfg, PROD } from "./config.js";
const E = process.env;

export const smsText = (otp) =>
  `HEMALATHA VEGETABLES\n\nYour Verification OTP is:\n\n${otp}\n\nThis OTP is valid for 10 minutes.\n\nDo not share this OTP with anyone.`;

// What the Settings page / Generate page show so the owner always knows if real SMS will go out.
export function smsStatus() {
  const p = cfg.provider;
  const need = { fast2sms: ["FAST2SMS_API_KEY"], msg91: ["MSG91_AUTH_KEY", "MSG91_TEMPLATE_ID"], twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"] }[p];
  if (!need) return { live: false, provider: p, note: PROD ? "SMS provider not set - add SMS_PROVIDER and its keys in your host's environment settings." : "Test mode: the OTP is printed in the server console instead of being sent as SMS." };
  const miss = need.filter((k) => !E[k]);
  return miss.length ? { live: false, provider: p, note: "Missing " + miss.join(", ") + " in environment settings." } : { live: true, provider: p, note: "Live SMS via " + p };
}

async function call(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
  let j = {}; try { j = await r.json(); } catch {}
  return { r, j };
}

export async function sendSms(phone, otp) {
  const p = cfg.provider, st = smsStatus();
  if (p === "console" || !["fast2sms", "msg91", "twilio"].includes(p)) {
    if (PROD) throw new Error("SMS provider is not configured");
    console.log(`[SMS test mode] to ${phone}: OTP ${otp}`); return;
  }
  if (!st.live) throw new Error(st.note);
  if (p === "fast2sms") {
    // dlt = your approved DLT template | q = free-text Quick SMS | otp = Fast2SMS standard "Your OTP: 1234" message
    const route = E.FAST2SMS_TEMPLATE_ID ? "dlt" : (E.FAST2SMS_ROUTE || "q").toLowerCase();
    const body = route === "dlt" ? { route, sender_id: E.FAST2SMS_SENDER_ID, message: E.FAST2SMS_TEMPLATE_ID, variables_values: otp, numbers: phone }
      : route === "otp" ? { route, variables_values: otp, numbers: phone }
      : { route: "q", message: smsText(otp), numbers: phone };
    const { r, j } = await call("https://www.fast2sms.com/dev/bulkV2", { method: "POST", headers: { authorization: E.FAST2SMS_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!j.return) throw new Error("Fast2SMS: " + String(j.message || r.status));
  } else if (p === "msg91") {
    const { r, j } = await call("https://control.msg91.com/api/v5/flow", { method: "POST", headers: { authkey: E.MSG91_AUTH_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ template_id: E.MSG91_TEMPLATE_ID, short_url: "0", recipients: [{ mobiles: "91" + phone, [E.MSG91_OTP_VAR || "otp"]: otp }] }) });
    if (!r.ok || j.type === "error") throw new Error("MSG91: " + String(j.message || r.status));
  } else {
    const { r, j } = await call(`https://api.twilio.com/2010-04-01/Accounts/${E.TWILIO_ACCOUNT_SID}/Messages.json`, { method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(E.TWILIO_ACCOUNT_SID + ":" + E.TWILIO_AUTH_TOKEN).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: "+91" + phone, From: E.TWILIO_FROM, Body: smsText(otp) }) });
    if (!r.ok) throw new Error("Twilio: " + String(j.message || r.status));
  }
}
