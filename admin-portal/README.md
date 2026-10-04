# Hemalatha Vegetables - ADMIN PORTAL (owner only)

Separate app. Receives every customer order live from the Customer Portal, and lets the owner generate / send / verify OTPs.
No packages needed to run (only Node.js 18+).

## Run on your computer (VS Code)
1. File > Open Folder > choose this `admin-portal` folder. Terminal > New Terminal.
2. `npm start`
3. Open http://localhost:4000/admin  - sign in with `9677291758` / `sabari2026` (local test password; change it before going live).
Keep this running, then start the Customer Portal in a second VS Code window (port 3000).

## How the two portals are connected
Customer Portal -> (signed secure message, `POST /api/ingest`) -> Admin Portal. Both must have the SAME `BRIDGE_SECRET`.
The customer portal's `BRIDGE_ADMIN_URL` must be this portal's link. If admin is offline, orders wait and arrive when it is back.

## Put it online (Render)
New > Web Service > this repo. Build: `npm install`  Start: `npm start`. Add Environment Variables from `.env.example`
(`NODE_ENV=production`, `OWNER_PHONE`, `ADMIN_PASSWORD_HASH`, `JWT_SECRET`, `OTP_ENC_KEY`, `BRIDGE_SECRET`, `SMS_PROVIDER` + SMS key).
Make NEW secrets for production: `npm run hash -- "your strong password"` and `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Your admin link = `https://<your-admin-name>.onrender.com/admin`.

## Real SMS
In `.env` set `SMS_PROVIDER=fast2sms` and `FAST2SMS_API_KEY=...` (MSG91 / Twilio also supported), restart.

## Permanent storage
Free hosts erase files on restart. For permanent orders + OTP history: create a free Supabase project, run `supabase/schema.sql`,
and set `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`. (Then run `npm install` so the optional Supabase package is installed.)
