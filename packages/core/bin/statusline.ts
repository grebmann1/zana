#!/usr/bin/env node
// Status line for Claude Code — shows hive state in the status bar.
// Config: "statusLine": { "type": "command", "command": "node <path>/statusline.js" }
const fs = require("node:fs"), path = require("node:path");
const http = require("node:http"), os = require("node:os");
const DAEMONS_DIR = path.join(os.homedir(), ".zana", "hives");
const STALE_MS = 30_000, HTTP_TIMEOUT = 500;

function listAliveHives() {
  let files;
  try { files = fs.readdirSync(DAEMONS_DIR).filter(f => f.endsWith(".json")); }
  catch { return []; }
  const alive = [];
  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(DAEMONS_DIR, f), "utf8"));
      const age = Date.now() - new Date(entry.lastHeartbeat || 0).getTime();
      if (age < STALE_MS) { alive.push(entry); continue; }
      try { process.kill(entry.pid, 0); alive.push(entry); } catch {}
    } catch {}
  }
  return alive;
}

function httpGet(port, ep) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}${ep}`, { timeout: HTTP_TIMEOUT }, res => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function main() {
  const hives = listAliveHives();
  if (!hives.length) process.exit(0);
  let agents = 0, tickets = 0, gotData = false;
  await Promise.all(hives.map(async h => {
    const [a, t] = await Promise.all([
      httpGet(h.port, "/hivemind/agents"),
      httpGet(h.port, "/tickets?status=in_progress"),
    ]);
    if (Array.isArray(a)) { agents += a.length; gotData = true; }
    if (Array.isArray(t)) { tickets += t.length; gotData = true; }
  }));
  const parts = [];
  if (gotData) {
    if (agents) parts.push(`${agents} agent${agents !== 1 ? "s" : ""}`);
    if (tickets) parts.push(`${tickets} ticket${tickets !== 1 ? "s" : ""}`);
  }
  process.stdout.write(`\u{1F41D} hive: ${parts.length ? parts.join(" | ") : "idle"}\n`);
}

main().catch(() => process.exit(0));
