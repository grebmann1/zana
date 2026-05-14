import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { HIVES_DIR } from "./config";

export const HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds
export const STALE_THRESHOLD_MS = 30_000;    // 30 seconds

function ensureDir() {
  fs.mkdirSync(HIVES_DIR, { recursive: true });
}

export function generateHiveId() {
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
  const filePath = path.join(HIVES_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + "\n", "utf8");
  return entry;
}

export function startHeartbeat(id) {
  const filePath = path.join(HIVES_DIR, `${id}.json`);
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
  const filePath = path.join(HIVES_DIR, `${id}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function list() {
  ensureDir();
  try {
    const files = fs.readdirSync(HIVES_DIR).filter((f) => f.endsWith(".json"));
    const entries = [];
    for (const f of files) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(HIVES_DIR, f), "utf8"));
        entries.push(entry);
      } catch {}
    }
    return entries;
  } catch {
    return [];
  }
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
  if (entry.lastHeartbeat) {
    const age = Date.now() - new Date(entry.lastHeartbeat).getTime();
    return age < STALE_THRESHOLD_MS;
  }
  // Backwards compatibility: no heartbeat field, fall back to PID check
  return isProcessAlive(entry.pid);
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
        fs.unlinkSync(path.join(HIVES_DIR, `${entry.id}.json`));
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
        fs.unlinkSync(path.join(HIVES_DIR, `${entry.id}.json`));
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
    const match = alive.find((e) => e.workspace === workspace && e.headless);
    if (match) return match;
  }
  const headless = alive.find((e) => e.headless);
  return headless || alive[0];
}

