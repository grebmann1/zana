// Persistence layer — crash-recoverable inbox + agent state snapshots.
// Uses NDJSON files to avoid native SQLite dependency.

import * as fs from "node:fs";
import * as path from "node:path";
import { PERSIST_DIR } from "./config";
const INBOX_FILE = path.join(PERSIST_DIR, "inboxes.ndjson");
const AGENTS_FILE = path.join(PERSIST_DIR, "agents.json");
const MAX_INBOX_FILE_LINES = 5000;

function ensureDir() {
  fs.mkdirSync(PERSIST_DIR, { recursive: true });
}

// --- Inbox Persistence ---

export function persistInboxMessage(agentId, msg) {
  ensureDir();
  const line = JSON.stringify({ agentId, msg, ts: Date.now() }) + "\n";
  fs.appendFileSync(INBOX_FILE, line, "utf8");
}

export function persistInboxDrain(agentId) {
  ensureDir();
  const line = JSON.stringify({ agentId, drained: true, ts: Date.now() }) + "\n";
  fs.appendFileSync(INBOX_FILE, line, "utf8");
}

export function recoverInboxes() {
  try {
    const raw = fs.readFileSync(INBOX_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const inboxes = new Map();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.drained) {
          inboxes.set(entry.agentId, []);
        } else if (entry.msg) {
          if (!inboxes.has(entry.agentId)) {
            inboxes.set(entry.agentId, []);
          }
          inboxes.get(entry.agentId).push(entry.msg);
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Compact: rewrite file with only current state
    compactInboxFile(inboxes);
    return inboxes;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[persistence] inbox recovery error:", err.message);
    }
    return new Map();
  }
}

export function compactInboxFile(inboxes) {
  ensureDir();
  let lines = "";
  for (const [agentId, messages] of inboxes) {
    for (const msg of messages) {
      lines += JSON.stringify({ agentId, msg, ts: Date.now() }) + "\n";
    }
  }
  fs.writeFileSync(INBOX_FILE, lines, "utf8");
}

export function clearInboxFile() {
  try { fs.unlinkSync(INBOX_FILE); } catch {}
}

// --- Agent State Snapshots ---

export function snapshotAgents(agents) {
  ensureDir();
  const data = agents.map((a) => ({
    id: a.id,
    profileId: a.profileId,
    profileName: a.profileName,
    terminalId: a.terminalId,
    mode: a.mode,
    state: a.state,
    spawnedAt: a.spawnedAt,
    lastActivity: a.lastActivity,
    lastAction: a.lastAction,
    result: a.result,
    parentAgentId: a.parentAgentId || null,
  }));
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function recoverAgentSnapshots() {
  try {
    const raw = fs.readFileSync(AGENTS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[persistence] agent snapshot recovery error:", err.message);
    }
    return [];
  }
}

export function clearAgentSnapshots() {
  try { fs.unlinkSync(AGENTS_FILE); } catch {}
}

// --- Channel Persistence ---

const CHANNELS_DIR = path.join(PERSIST_DIR, "channels");

function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9\-_]/g, "").slice(0, 128);
}

function ensureChannelsDir() {
  fs.mkdirSync(CHANNELS_DIR, { recursive: true });
}

export function persistChannelMessage(channelName, msg) {
  ensureChannelsDir();
  const filePath = path.join(CHANNELS_DIR, `${sanitizeName(channelName)}.ndjson`);
  const line = JSON.stringify(msg) + "\n";
  fs.appendFileSync(filePath, line, "utf8");
}

export function recoverChannels() {
  const result = new Map();
  try {
    ensureChannelsDir();
    const files = fs.readdirSync(CHANNELS_DIR);
    for (const file of files) {
      if (!file.endsWith(".ndjson")) continue;
      const channelName = file.slice(0, -".ndjson".length);
      const filePath = path.join(CHANNELS_DIR, file);
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        const messages = [];
        for (const line of lines) {
          try {
            messages.push(JSON.parse(line));
          } catch {
            // Skip malformed lines
          }
        }
        if (messages.length > 0) {
          result.set(channelName, messages);
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[persistence] channel recovery error:", err.message);
    }
  }
  return result;
}

// --- Periodic Compaction ---

let compactionInterval = null;

export function startPeriodicCompaction(getInboxesFn) {
  compactionInterval = setInterval(() => {
    try {
      const stat = fs.statSync(INBOX_FILE);
      if (stat.size > MAX_INBOX_FILE_LINES * 200) {
        const inboxes = getInboxesFn();
        compactInboxFile(inboxes);
      }
    } catch {
      // File doesn't exist yet — normal
    }
  }, 60000);
}

export function stopPeriodicCompaction() {
  if (compactionInterval) {
    clearInterval(compactionInterval);
    compactionInterval = null;
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function recoverOrphanedAgents() {
  const snapshots = recoverAgentSnapshots();
  if (snapshots.length === 0) return { adopted: [], lost: [] };

  const adopted = [];
  const lost = [];

  for (const agent of snapshots) {
    if (agent.state === "terminated") continue;
    if (agent.pid && isProcessAlive(agent.pid)) {
      adopted.push({ ...agent, recoveredState: "re-adopted" });
    } else {
      lost.push({
        ...agent,
        state: "terminated",
        result: "Lost (daemon restart)",
        terminatedAt: new Date().toISOString(),
      });
    }
  }

  return { adopted, lost };
}

