// Usage: npm run hash -- "your new password"   -> paste the printed line into .env as ADMIN_PASSWORD_HASH
import crypto from "crypto";
const salt = crypto.randomBytes(16).toString("hex");
console.log(`scrypt$${salt}$${crypto.scryptSync(process.argv[2] || "", salt, 64).toString("hex")}`);
