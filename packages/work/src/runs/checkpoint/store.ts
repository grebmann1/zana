import * as fs from "fs";
import * as path from "path";
import * as crypto from "node:crypto";

let checkpointsDir = null;

export function init(projectDir) {
  checkpointsDir = path.join(projectDir, "checkpoints");
  fs.mkdirSync(checkpointsDir, { recursive: true });
}

function getDir() {
  if (!checkpointsDir) {
    const { ZANA_DIR } = require("@zana/core").config;
    checkpointsDir = path.join(ZANA_DIR, "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
  }
  return checkpointsDir;
}

export function save(checkpoint) {
  if (!checkpoint.id) checkpoint.id = crypto.randomUUID();
  if (!checkpoint.createdAt) checkpoint.createdAt = Date.now();
  checkpoint.updatedAt = Date.now();
  // Default kind for backward compat: pre-existing checkpoints loaded via
  // load() preserve absence of `kind`; only freshly-saved records that omit
  // the field are normalized to "run". `expiresAt` is left untouched.
  if (checkpoint.kind === undefined) checkpoint.kind = "run";

  // Tenant isolation gate (FU-T4c): refuse deliberation writes when the
  // workspace is not initialized. The fallback path (~/.zana/checkpoints/)
  // is shared across every workspace on this host — landing a deliberation
  // record there would let workspaces with independent quorum/TTL settings
  // silently share state. Other kinds ("run", and unknown legacy kinds)
  // are unaffected so existing autopilot/team checkpoint flows keep working.
  if (checkpoint.kind === "deliberation") {
    const core = require("@zana/core");
    const ctx = core.project.workspaceContext;
    if (!ctx.isInitialized()) {
      const ErrCtor = ctx.WorkspaceNotInitializedError;
      throw new ErrCtor({
        operation: "write",
        path: path.join(core.config.ZANA_DIR, "checkpoints"),
        requestedKind: "deliberation",
      });
    }
  }

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

  const includeExpired = filter.includeExpired === true;
  const now = Date.now();

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const results = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (filter.teamId && data.teamId !== filter.teamId) continue;
      if (filter.runId && data.runId !== filter.runId) continue;
      if (filter.status && data.status !== filter.status) continue;
      if (filter.kind && data.kind !== filter.kind) continue;
      if (!includeExpired && typeof data.expiresAt === "number" && data.expiresAt < now) continue;
      results.push(data);
    } catch {}
  }

  return results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Remove any checkpoint whose `expiresAt` lies in the past. Idempotent: a
// second call after the first will return an empty `removed` array because
// the matching files no longer exist on disk. Records without `expiresAt`
// are never touched (backward compat for legacy checkpoints).
// sweepExpired is kind-agnostic — sweeps any kind with past expiresAt.
export function sweepExpired(now = Date.now()) {
  const dir = getDir();
  const removed = [];
  if (!fs.existsSync(dir)) return { removed };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const filePath = path.join(dir, file);
    let id = file.replace(/\.json$/, "");
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      id = data.id || id;
      if (typeof data.expiresAt === "number" && data.expiresAt < now) {
        try {
          fs.unlinkSync(filePath);
          removed.push(id);
        } catch (err) {
          console.warn(`[checkpoint] sweep unlink failed for ${id}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[checkpoint] sweep read failed for ${id}: ${err.message}`);
    }
  }
  return { removed };
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

