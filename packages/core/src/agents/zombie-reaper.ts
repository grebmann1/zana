/**
 * Zombie reaper — kills claude headless processes the daemon no longer
 * tracks. Survives daemon restarts: when the daemon goes away, every
 * agent it had spawned becomes orphaned (re-parented to pid 1) and stops
 * being managed by the in-memory timeout. Without this reaper, those
 * processes can pile up for days, eating CPU on bad days (we observed
 * a 10-process pile-up at load 108 during dogfooding — see #99dbc912).
 *
 * Heuristic: any `claude --name X` process whose ppid is 1 AND whose
 * elapsed time exceeds the configured threshold gets SIGTERM. We
 * deliberately do NOT touch processes with a live parent, because those
 * are owned by some live daemon (possibly another zana instance, or a
 * Slack-reporter, or the user's interactive Claude Code session).
 *
 * Design choices:
 *   - Use `ps` rather than reading /proc/<pid>/environ — macOS doesn't
 *     expose another process's environ, and parsing platform-specific
 *     procfs would double the surface area.
 *   - Match by `--name` flag only, NOT by binary path — the binary path
 *     is shared by the user's interactive Claude session. The `--name`
 *     flag is a Zana-specific marker; an interactive session has no
 *     `--name` flag.
 *   - Reaper is opt-in via cfg.system.zombieReaperEnabled (default true)
 *     and runs every cfg.system.zombieReaperIntervalMs (default 60000).
 *     Set to 0 to disable; set to a smaller value in tests.
 */

import { execFileSync } from "node:child_process";
import * as moduleConfig from "../modules/config";

interface ProcessRow {
  pid: number;
  ppid: number;
  etimeSeconds: number;
  command: string;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_GRACE_MS = 5 * 60 * 1000; // 5 minutes — well above slowest start-up

let timer: NodeJS.Timeout | null = null;

/** Test seam: override how we read process state. Defaults to real `ps`. */
let processLister: () => ProcessRow[] = listClaudeProcesses;
/** Test seam: override how we kill. Defaults to real process.kill. */
let killer: (pid: number, sig: NodeJS.Signals) => void = (pid, sig) => {
  process.kill(pid, sig);
};

export function _setTestSeams(opts: {
  processLister?: () => ProcessRow[];
  killer?: (pid: number, sig: NodeJS.Signals) => void;
}) {
  if (opts.processLister) processLister = opts.processLister;
  if (opts.killer) killer = opts.killer;
}

export function _resetTestSeams() {
  processLister = listClaudeProcesses;
  killer = (pid, sig) => process.kill(pid, sig);
}

function getConfig() {
  const sys = moduleConfig.get()?.system as any;
  return {
    enabled: sys?.zombieReaperEnabled !== false,
    intervalMs: sys?.zombieReaperIntervalMs ?? DEFAULT_INTERVAL_MS,
    graceMs: sys?.zombieReaperGraceMs ?? DEFAULT_GRACE_MS,
  };
}

/**
 * Parse `ps -eo pid,ppid,etime,command` rows looking for claude headless
 * agents (--name marker). Returns the rows we'd consider for reaping.
 */
function listClaudeProcesses(): ProcessRow[] {
  let raw: string;
  try {
    raw = execFileSync(
      "/bin/ps",
      ["-eo", "pid=,ppid=,etime=,command="],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    return [];
  }
  const rows: ProcessRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Greedy match: pid ppid etime command-rest
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pidS, ppidS, etime, command] = m;
    if (!command.includes("--name ")) continue;
    if (!command.includes("/claude") && !command.startsWith("claude")) continue;
    rows.push({
      pid: Number(pidS),
      ppid: Number(ppidS),
      etimeSeconds: parseEtime(etime),
      command,
    });
  }
  return rows;
}

/** Parse `ps` etime format: [[dd-]hh:]mm:ss → seconds. */
export function parseEtime(s: string): number {
  // Forms: SS, MM:SS, HH:MM:SS, DD-HH:MM:SS
  let days = 0;
  let rest = s;
  const dashIdx = rest.indexOf("-");
  if (dashIdx > 0) {
    days = Number(rest.slice(0, dashIdx)) || 0;
    rest = rest.slice(dashIdx + 1);
  }
  const parts = rest.split(":").map((p) => Number(p) || 0);
  let h = 0, m = 0, sec = 0;
  if (parts.length === 3) [h, m, sec] = parts;
  else if (parts.length === 2) [m, sec] = parts;
  else if (parts.length === 1) [sec] = parts;
  return days * 86400 + h * 3600 + m * 60 + sec;
}

/**
 * Run one sweep. Returns the list of pids that were killed. Public so
 * tests and ops tooling can trigger it on demand.
 */
export function reapOnce(): { reaped: number[]; skipped: number; total: number } {
  const cfg = getConfig();
  if (!cfg.enabled) return { reaped: [], skipped: 0, total: 0 };
  const rows = processLister();
  const reaped: number[] = [];
  let skipped = 0;
  const graceSec = Math.floor(cfg.graceMs / 1000);
  for (const row of rows) {
    if (row.ppid !== 1) {
      skipped++;
      continue;
    }
    if (row.etimeSeconds < graceSec) {
      skipped++;
      continue;
    }
    try {
      killer(row.pid, "SIGTERM");
      reaped.push(row.pid);
      process.stderr.write(
        `[zombie-reaper] reaped pid=${row.pid} etime=${row.etimeSeconds}s ppid=1 (orphan)\n`,
      );
    } catch (err: any) {
      // Process may have already died between the ps and our kill.
      process.stderr.write(`[zombie-reaper] kill failed pid=${row.pid}: ${err?.message || err}\n`);
    }
  }
  return { reaped, skipped, total: rows.length };
}

export function start(): () => void {
  const cfg = getConfig();
  if (!cfg.enabled || cfg.intervalMs <= 0) return () => {};
  // Run once at start so existing zombies from a prior daemon get cleaned up
  // promptly rather than waiting a full interval.
  try { reapOnce(); } catch (err) {
    process.stderr.write(`[zombie-reaper] initial sweep failed: ${(err as any)?.message || err}\n`);
  }
  timer = setInterval(() => {
    try { reapOnce(); } catch (err) {
      process.stderr.write(`[zombie-reaper] sweep failed: ${(err as any)?.message || err}\n`);
    }
  }, cfg.intervalMs);
  if (timer.unref) timer.unref();
  return stop;
}

export function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function _isRunning(): boolean {
  return timer !== null;
}
