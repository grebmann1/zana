import * as fs from "fs";
import * as path from "path";

let sessionId = null;
let sessionDir = null;
let globalStream = null;

function getSessionsDir() {
  const ctx = require("./workspace-context");
  if (ctx.isInitialized()) return ctx.getProjectPaths().sessionsDir;
  const { SESSIONS_DIR } = require("./config");
  return SESSIONS_DIR;
}

function getAuditDir() {
  const ctx = require("./workspace-context");
  if (ctx.isInitialized()) return ctx.getProjectPaths().auditDir;
  const { HIVE_DIR } = require("./config");
  return path.join(HIVE_DIR, "audit");
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

  globalStream = fs.createWriteStream(
    path.join(sessionDir, "events.ndjson"),
    { flags: "a" }
  );

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

  if (globalStream) {
    globalStream.write(line);
  }

  const terminalId = payload.hive_terminal_id;
  if (terminalId) {
    const agentFile = path.join(sessionDir, "agents", `${terminalId}.ndjson`);
    fs.appendFileSync(agentFile, line, "utf8");
  }
}

export function appendAudit(payload) {
  const auditDir = getAuditDir();
  fs.mkdirSync(auditDir, { recursive: true });
  const line = JSON.stringify({ ts: Date.now(), ...payload }) + "\n";
  fs.appendFileSync(path.join(auditDir, "audit.ndjson"), line, "utf8");
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
  if (globalStream) {
    globalStream.end();
    globalStream = null;
  }
}

