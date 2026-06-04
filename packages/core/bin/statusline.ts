#!/usr/bin/env node
// Status line for Claude Code — single-line footer showing zana state for the
// current workspace. Reads:
//   - stdin JSON (Claude Code passes .workspace.current_dir)
//   - ~/.zana/daemons/*.json (running daemon registry)
//   - $WORKSPACE/.zana/scheduler/*.yml (active schedules)
//   - $WORKSPACE/.zana/tickets.db (better-sqlite3, read-only) — counts by status
//   - daemon HTTP endpoint (/swarm/agents) for the workspace's daemon, if up
//
// Output:
//   ⚡ zana off | 2 schedule(s) | tickets: 1 doing · 16 todo
//   ⚡ zana on (pid 1234) | 2 sched ⏱ next 6m | 1 agent | tickets: 1 doing · 16 todo (+1 other daemon)
//
// Tickets surface from the DB whether or not the daemon is running. Always
// exits 0; never blocks Claude Code's prompt.

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

export function getWorkspace(stdinRaw: string): string {
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

type TicketCounts = { inProgress: number; review: number; backlog: number; blocked: number };
type TicketReadout = { active: TicketCounts | null; backlog: number };

function readTicketCounts(workspace: string): TicketReadout | null {
  const dbPath = path.join(workspace, ".zana", "tickets.db");
  if (!fs.existsSync(dbPath)) return null;
  let Database: any;
  try { Database = require("better-sqlite3"); } catch { return null; }
  let db: any;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    // Find the active sprint (if any). Earliest startedAt wins on ties.
    let activeSprintId: string | null = null;
    try {
      const row = db.prepare("SELECT id FROM sprints WHERE status='active' ORDER BY startedAt ASC LIMIT 1").get() as { id?: string } | undefined;
      if (row?.id) activeSprintId = row.id;
    } catch { /* sprints table may not exist on legacy DBs */ }

    const tally = (rows: Array<{ status: string; n: number }>): TicketCounts => {
      const c: TicketCounts = { inProgress: 0, review: 0, backlog: 0, blocked: 0 };
      for (const r of rows) {
        if (r.status === "in-progress") c.inProgress = r.n;
        else if (r.status === "review") c.review = r.n;
        else if (r.status === "backlog") c.backlog = r.n;
        else if (r.status === "blocked") c.blocked = r.n;
      }
      return c;
    };

    let active: TicketCounts | null = null;
    if (activeSprintId) {
      const sprintRows = db.prepare("SELECT status, COUNT(*) AS n FROM tickets WHERE sprintId=? GROUP BY status").all(activeSprintId) as Array<{ status: string; n: number }>;
      active = tally(sprintRows);
    }

    const globalBacklog = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='backlog'").get() as { n: number } | undefined)?.n || 0;
    const backlogOutsideSprint = activeSprintId
      ? globalBacklog - (active?.backlog || 0)
      : globalBacklog;

    return { active, backlog: backlogOutsideSprint };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function ticketLabel(r: TicketReadout | null): string | null {
  if (!r) return null;
  const parts: string[] = [];
  if (r.active) {
    if (r.active.inProgress > 0) parts.push(`${r.active.inProgress} doing`);
    if (r.active.review > 0) parts.push(`${r.active.review} review`);
    if (r.active.blocked > 0) parts.push(`${r.active.blocked} blocked`);
    if (r.active.backlog > 0) parts.push(`${r.active.backlog} todo`);
  }
  let label: string | null = null;
  if (parts.length > 0) label = `sprint: ${parts.join(" · ")}`;
  if (r.backlog > 0) {
    const bk = `${r.backlog} backlog`;
    label = label ? `${label} (+${bk})` : `tickets: ${bk}`;
  }
  return label;
}

export function relativeLabel(iso: string | null): string | null {
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
  const ticketCounts = readTicketCounts(workspace);
  const ticketStr = ticketLabel(ticketCounts);

  if (!ws) {
    const parts: string[] = ["⚡ zana off"];
    if (schedCount > 0) parts.push(`${schedCount} schedule${schedCount !== 1 ? "s" : ""}`);
    if (ticketStr) parts.push(ticketStr);
    process.stdout.write(`${parts.join(" | ")}\n`);
    return;
  }

  let agents: number | null = null;
  const a = await httpGet(ws.port, "/swarm/agents");
  if (Array.isArray(a)) agents = a.length;

  const parts: string[] = [`⚡ zana on (pid ${ws.pid})`];
  if (schedCount > 0) {
    let s = `${schedCount} sched`;
    if (nextLabel) s += ` ⏱ next ${nextLabel}`;
    parts.push(s);
  }
  if (agents !== null) parts.push(`${agents} agent${agents !== 1 ? "s" : ""}`);
  if (ticketStr) parts.push(ticketStr);
  let out = parts.join(" | ");
  if (otherCount > 0) out += ` (+${otherCount} other daemon${otherCount !== 1 ? "s" : ""})`;
  process.stdout.write(`${out}\n`);
}

main().catch(() => process.exit(0));
