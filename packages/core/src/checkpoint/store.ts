import * as fs from "fs";
import * as path from "path";
import * as crypto from "node:crypto";

let checkpointsDir = null;

export function init(hiveDir) {
  checkpointsDir = path.join(hiveDir, "checkpoints");
  fs.mkdirSync(checkpointsDir, { recursive: true });
}

function getDir() {
  if (!checkpointsDir) {
    const { HIVE_DIR } = require("../config.ts");
    checkpointsDir = path.join(HIVE_DIR, "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
  }
  return checkpointsDir;
}

export function save(checkpoint) {
  if (!checkpoint.id) checkpoint.id = crypto.randomUUID();
  if (!checkpoint.createdAt) checkpoint.createdAt = Date.now();
  checkpoint.updatedAt = Date.now();

  const filePath = path.join(getDir(), `${checkpoint.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2) + "\n");
  return checkpoint;
}

export function load(id) {
  const filePath = path.join(getDir(), `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(`[checkpoint] failed to load ${id}:`, err.message);
    return null;
  }
}

export function list(filter = {}) {
  const dir = getDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const results = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (filter.teamId && data.teamId !== filter.teamId) continue;
      if (filter.runId && data.runId !== filter.runId) continue;
      if (filter.status && data.status !== filter.status) continue;
      results.push(data);
    } catch {}
  }

  return results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function remove(id) {
  const filePath = path.join(getDir(), `${id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

export function update(id, updates) {
  const existing = load(id);
  if (!existing) return null;
  const merged = { ...existing, ...updates, id, updatedAt: Date.now() };
  save(merged);
  return merged;
}

export function addCompletedAgent(checkpointId, agentData) {
  const cp = load(checkpointId);
  if (!cp) return null;

  if (!cp.completedAgents) cp.completedAgents = [];
  cp.completedAgents.push({
    agentId: agentData.agentId,
    profileId: agentData.profileId,
    profileName: agentData.profileName,
    prompt: agentData.prompt || "",
    result: agentData.result || "",
    exitCode: agentData.exitCode ?? 0,
    completedAt: Date.now(),
  });

  if (cp.pendingAgents) {
    cp.pendingAgents = cp.pendingAgents.filter((p) => p.agentId !== agentData.agentId);
  }

  cp.updatedAt = Date.now();
  save(cp);
  return cp;
}

export function addPendingAgent(checkpointId, agentData) {
  const cp = load(checkpointId);
  if (!cp) return null;

  if (!cp.pendingAgents) cp.pendingAgents = [];
  cp.pendingAgents.push({
    agentId: agentData.agentId || null,
    profileId: agentData.profileId,
    prompt: agentData.prompt,
    parentAgentId: agentData.parentAgentId || null,
    dependencies: agentData.dependencies || [],
  });

  cp.updatedAt = Date.now();
  save(cp);
  return cp;
}

