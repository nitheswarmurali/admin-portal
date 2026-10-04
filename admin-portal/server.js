// HEMALATHA VEGETABLES - ADMIN PORTAL (separate app, zero dependencies).  Run: npm start  ->  http://localhost:4000/admin
import http from "http";
import adminPortal from "./src/portal.js";
import { cfg } from "./src/config.js";

const MAX_BODY = 64 * 1024;
const server = http.createServer((req, res) => {
  const chunks = []; let size = 0, dead = false;
  req.on("data", (d) => {
    size += d.length;
    if (size > MAX_BODY) { if (!dead) { dead = true; res.statusCode = 413; res.end("Too large"); req.destroy(); } return; }
    chunks.push(d);
  });
  req.on("end", () => {
    if (dead) return;
    const raw = Buffer.concat(chunks).toString("utf8");
    req.rawBody = raw; req.body = {};
    if (raw && /json/.test(req.headers["content-type"] || "")) {
      try { req.body = JSON.parse(raw); } catch { res.statusCode = 400; res.setHeader("Content-Type", "application/json"); return res.end('{"error":"Bad JSON"}'); }
    }
    adminPortal(req, res, () => {
      const p = (req.url || "").split("?")[0];
      if (p === "/") { res.statusCode = 302; res.setHeader("Location", "/admin/"); return res.end(); }
      if (p === "/health") { res.setHeader("Content-Type", "text/plain"); return res.end("ok"); }
      res.statusCode = 404; res.end("Not found");
    });
  });
});
process.on("unhandledRejection", (e) => console.error("[admin] unhandled:", e));
server.listen(cfg.port, () => console.log(`ADMIN PORTAL running on http://localhost:${cfg.port}/admin`));
