#!/usr/bin/env node
// Status line for Claude Code — single-line footer showing zana state for the
// current workspace. Reads:
//   - stdin JSON (Claude Code passes .workspace.current_dir)
//   - ~/.zana/daemons/*.json (running daemon registry)
//   - $WORKSPACE/.zana/scheduler/*.yml (active schedules)
//   - daemon HTTP endpoints (/swarm/agents, /tickets) for the workspace's daemon
//
// Output:
//   ⚡ zana off | 2 schedule(s)
//   ⚡ zana on (pid 1234) | 2 sched ⏱ next 6m | 1 agent | 0 tickets (+1 other daemon)
//
// Always exits 0; never blocks Claude Code's prompt.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");

const DAEMONS_DIR = path.join(os.homedir(), ".zana", "daemons");
const STALE_MS = 30_000;
const HTTP_TIMEOUT = 500;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
    setTimeout(() => resolve(buf), 200);
  });
}

function getWorkspace(stdinRaw: string): string {
  try {
    const j = JSON.parse(stdinRaw);
    const dir = j?.workspace?.current_dir;
    if (typeof dir === "string" && dir) return dir;
  } catch {}
  return process.cwd();
}

type DaemonEntry = {
  pid: number;
  port: number;
  workspace?: string;
  lastHeartbeat?: string;
};

function listAliveDaemons(): DaemonEntry[] {
  let files: string[];
  try { files = fs.readdirSync(DAEMONS_DIR).filter((f: string) => f.endsWith(".json")); }
  catch { return []; }
  const alive: DaemonEntry[] = [];
  for (const f of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(DAEMONS_DIR, f), "utf8"));
      if (typeof entry?.pid !== "number") continue;
      const age = Date.now() - new Date(entry.lastHeartbeat || 0).getTime();
      if (age < STALE_MS) { alive.push(entry); continue; }
      try { process.kill(entry.pid, 0); alive.push(entry); } catch {}
    } catch {}
  }
  return alive;
}

type ScheduleInfo = { count: number; nextRunIso: string | null };

function readSchedules(workspace: string): ScheduleInfo {
  const dir = path.join(workspace, ".zana", "scheduler");
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".yml")); }
  catch { return { count: 0, nextRunIso: null }; }

  let count = 0;
  let nextRunIso: string | null = null;
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const enabled = /^enabled:\s*true\s*$/m.test(text);
      if (!enabled) continue;
      count += 1;
      const match = text.match(/^\s*nextRunAt:\s*(\S+)\s*$/m);
      if (match) {
        const iso = match[1].replace(/^["']|["']$/g, "");
        if (!nextRunIso || iso < nextRunIso) nextRunIso = iso;
      }
    } catch {}
  }
  return { count, nextRunIso };
}

function relativeLabel(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diff = Math.floor((t - Date.now()) / 1000);
  if (diff < 0) return "(due now)";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

function httpGet(port: number, ep: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}${ep}`,
      { timeout: HTTP_TIMEOUT },
      (res: any) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c; });
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function main() {
  const stdinRaw = await readStdin();
  const workspace = getWorkspace(stdinRaw);

  const daemons = listAliveDaemons();
  const ws = daemons.find((d) => d.workspace === workspace);
  const otherCount = daemons.length - (ws ? 1 : 0);

  const { count: schedCount, nextRunIso } = readSchedules(workspace);
  const nextLabel = relativeLabel(nextRunIso);

  if (!ws) {
    process.stdout.write(`⚡ zana off | ${schedCount} schedule(s)\n`);
    return;
  }

  let agents: number | null = null;
  let tickets: number | null = null;
  const [a, t] = await Promise.all([
    httpGet(ws.port, "/swarm/agents"),
    httpGet(ws.port, "/tickets?status=in_progress"),
  ]);
  if (Array.isArray(a)) agents = a.length;
  if (Array.isArray(t)) tickets = t.length;

  const parts: string[] = [`⚡ zana on (pid ${ws.pid})`];
  if (schedCount > 0) {
    let s = `${schedCount} sched`;
    if (nextLabel) s += ` ⏱ next ${nextLabel}`;
    parts.push(s);
  }
  if (agents !== null) parts.push(`${agents} agent${agents !== 1 ? "s" : ""}`);
  if (tickets !== null) parts.push(`${tickets} ticket${tickets !== 1 ? "s" : ""}`);
  let out = parts.join(" | ");
  if (otherCount > 0) out += ` (+${otherCount} other daemon${otherCount !== 1 ? "s" : ""})`;
  process.stdout.write(`${out}\n`);
}

main().catch(() => process.exit(0));
