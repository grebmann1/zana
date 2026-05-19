import * as fs from "fs";
import * as path from "path";

let sessionId = null;
let sessionDir = null;

// Lazy-resolve to avoid CJS require-cycle issues when log.ts is loaded
// before the facade is wired (e.g. directly via vitest's source-mode import).
function _ctx() {
  try {
    // Prefer the facade so test and runtime see the same singleton.
    return require("@zana/core").project.workspaceContext;
  } catch {
    return require("../project/workspace-context");
  }
}
function _config() {
  try {
    return require("@zana/core").config;
  } catch {
    return require("../config");
  }
}

function getSessionsDir() {
  const ctx = _ctx();
  if (ctx.isInitialized()) return ctx.getProjectPaths().sessionsDir;
  return _config().SESSIONS_DIR;
}

function getAuditDir() {
  const ctx = _ctx();
  if (ctx.isInitialized()) return ctx.getProjectPaths().auditDir;
  return path.join(_config().ZANA_DIR, "audit");
}

// --- size-based rotation ---
//
// NDJSON files grow forever otherwise. We rotate when file size crosses a
// threshold: rename current file to `<name>.<ts>.<ext>`, then keep at most
// `retainCount` rolled siblings (oldest pruned). Configurable via env so
// noisy cases (CI, soak tests) can tune without redeploying.

const DEFAULT_EVENT_LOG_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_AUDIT_LOG_MAX_BYTES = 250 * 1024 * 1024; // 250 MB
const DEFAULT_RETAIN_COUNT = 5;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function eventLogMaxBytes() {
  return envInt("ZANA_EVENT_LOG_MAX_BYTES", DEFAULT_EVENT_LOG_MAX_BYTES);
}
function auditLogMaxBytes() {
  return envInt("ZANA_AUDIT_LOG_MAX_BYTES", DEFAULT_AUDIT_LOG_MAX_BYTES);
}
function logRetainCount() {
  return envInt("ZANA_LOG_RETAIN_COUNT", DEFAULT_RETAIN_COUNT);
}

/**
 * If the file at `filePath` exceeds `maxBytes`, rename it to a timestamped
 * sibling (so future appends start fresh) and prune older rolled siblings.
 * No-op if the file doesn't exist or is under the cap. Errors are swallowed
 * — log writes are best-effort and we never want rotation to break the
 * caller's path.
 */
export function rotateIfNeeded(filePath: string, maxBytes: number, retainCount = logRetainCount()) {
  try {
    const st = fs.statSync(filePath);
    if (st.size < maxBytes) return;
  } catch {
    return; // missing file — nothing to rotate
  }
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rolled = path.join(dir, `${stem}.${ts}${ext}`);
    fs.renameSync(filePath, rolled);

    // Prune oldest rolled siblings beyond retainCount.
    const prefix = `${stem}.`;
    const entries = fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f !== base && f.endsWith(ext))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const old of entries.slice(retainCount)) {
      try { fs.unlinkSync(path.join(dir, old.name)); } catch {}
    }
  } catch {
    // best-effort
  }
}

function appendWithRotation(filePath: string, line: string, maxBytes: number) {
  rotateIfNeeded(filePath, maxBytes);
  fs.appendFileSync(filePath, line, "utf8");
}

export function init(workspace) {
  sessionId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  sessionDir = path.join(getSessionsDir(), sessionId);
  const agentsDir = path.join(sessionDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  const meta = {
    sessionId,
    workspace: workspace || null,
    startedAt: new Date().toISOString(),
    agents: [],
  };
  fs.writeFileSync(
    path.join(sessionDir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );

  // Touch the global events file so subsequent appends + rotation logic can
  // statSync it. We don't hold an open WriteStream anymore — appendFileSync
  // is what rotation needs (the WriteStream's internal buffer would write to
  // the rolled file's old fd after rename).
  const globalPath = path.join(sessionDir, "events.ndjson");
  if (!fs.existsSync(globalPath)) fs.writeFileSync(globalPath, "", "utf8");

  // Write session start to audit log
  appendAudit({ event: "session_start", sessionId, workspace: workspace || null });
}

export function append(payload) {
  if (!sessionDir) return;

  const entry = {
    ts: Date.now(),
    ...payload,
  };
  const line = JSON.stringify(entry) + "\n";

  const globalPath = path.join(sessionDir, "events.ndjson");
  appendWithRotation(globalPath, line, eventLogMaxBytes());

  const terminalId = payload.zana_terminal_id;
  if (terminalId) {
    const agentFile = path.join(sessionDir, "agents", `${terminalId}.ndjson`);
    appendWithRotation(agentFile, line, eventLogMaxBytes());
  }
}

export function appendAudit(payload) {
  const auditDir = getAuditDir();
  fs.mkdirSync(auditDir, { recursive: true });
  const line = JSON.stringify({ ts: Date.now(), ...payload }) + "\n";
  appendWithRotation(path.join(auditDir, "audit.ndjson"), line, auditLogMaxBytes());
}

export function queryByTerminal(terminalId, { limit = 200, offset = 0 } = {}) {
  if (!sessionDir) return [];
  const agentFile = path.join(sessionDir, "agents", `${terminalId}.ndjson`);
  if (!fs.existsSync(agentFile)) return [];

  try {
    const content = fs.readFileSync(agentFile, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const events = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    return events.slice(offset, offset + limit);
  } catch {
    return [];
  }
}

export function getSessionId() {
  return sessionId;
}

export function close() {
  // Nothing to do — appends are sync. Kept for API compatibility.
}
