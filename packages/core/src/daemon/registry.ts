import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { DAEMONS_DIR } from "../config";

export const HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds
export const STALE_THRESHOLD_MS = 30_000;    // 30 seconds

function ensureDir() {
  fs.mkdirSync(DAEMONS_DIR, { recursive: true });
}

function readEntriesFrom(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const entries = [];
    for (const f of files) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        entries.push(entry);
      } catch {}
    }
    return entries;
  } catch {
    return [];
  }
}

export function generateDaemonId() {
  return crypto.randomUUID().slice(0, 8);
}

export function register({ id, port, workspace, headless = false }) {
  ensureDir();
  const now = new Date().toISOString();
  const entry = {
    id,
    port,
    pid: process.pid,
    workspace,
    headless,
    startedAt: now,
    lastHeartbeat: now,
  };
  const filePath = path.join(DAEMONS_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + "\n", "utf8");
  return entry;
}

export function startHeartbeat(id) {
  const filePath = path.join(DAEMONS_DIR, `${id}.json`);
  const interval = setInterval(() => {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const entry = JSON.parse(raw);
      entry.lastHeartbeat = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + "\n", "utf8");
    } catch {
      // File may have been deleted externally; ignore
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Don't keep the process alive just for heartbeats
  if (interval.unref) interval.unref();

  return function stopHeartbeat() {
    clearInterval(interval);
  };
}

export function deregister(id) {
  const filePath = path.join(DAEMONS_DIR, `${id}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function list() {
  ensureDir();
  const entries = readEntriesFrom(DAEMONS_DIR);
  // One-shot migration from legacy ~/.zana/hives
  const LEGACY = path.join(os.homedir(), ".zana", "hives");
  if (fs.existsSync(LEGACY)) {
    for (const f of fs.readdirSync(LEGACY)) {
      const src = path.join(LEGACY, f);
      const dst = path.join(DAEMONS_DIR, f);
      try {
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
        else fs.unlinkSync(src);
      } catch {}
    }
    try { fs.rmdirSync(LEGACY); } catch {}
    return readEntriesFrom(DAEMONS_DIR);
  }
  return entries;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isEntryAlive(entry) {
  // PID is authoritative — a heartbeat that's only seconds old is meaningless
  // if the process is gone. Check liveness first, then fall back to staleness.
  if (entry.pid && !isProcessAlive(entry.pid)) return false;
  if (entry.lastHeartbeat) {
    const age = Date.now() - new Date(entry.lastHeartbeat).getTime();
    return age < STALE_THRESHOLD_MS;
  }
  // No heartbeat field and PID checked above — if we got here, PID was missing
  // or alive. Treat as alive (best-effort backward compat).
  return true;
}

export function listAlive() {
  const all = list();
  const alive = [];
  for (const entry of all) {
    if (isEntryAlive(entry)) {
      alive.push(entry);
    } else {
      // Clean up stale entry
      try {
        fs.unlinkSync(path.join(DAEMONS_DIR, `${entry.id}.json`));
      } catch {}
    }
  }
  return alive;
}

export function cleanStale() {
  const all = list();
  let removed = 0;
  for (const entry of all) {
    if (!isEntryAlive(entry)) {
      try {
        fs.unlinkSync(path.join(DAEMONS_DIR, `${entry.id}.json`));
        removed++;
      } catch {}
    }
  }
  return removed;
}

export function findRunningDaemon(workspace) {
  const alive = listAlive();
  if (alive.length === 0) return null;
  if (workspace) {
    // Caller specified a workspace — only return a daemon for THAT workspace.
    // Falling through to "any headless daemon" here causes false positives in
    // the concurrent-daemon guard: a stale daemon for /repo-A would block a
    // legitimate startup for /repo-B (auditor finding 6fcb24e6).
    return alive.find((e) => e.workspace === workspace && e.headless) || null;
  }
  // No workspace specified — caller wants any running daemon.
  return alive.find((e) => e.headless) || alive[0];
}

