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

// ─────────────────────────────────────────────────────────────────────────────
// Cross-process safety primitives (T5x-cross-proc).
//
// Two pieces:
//   1) atomicWriteSync — write-tmp + rename, with cleanup on throw. Eliminates
//      the partial-file window that fs.writeFileSync exposes.
//   2) withFileLockSync — best-effort advisory lock via O_CREAT|O_EXCL lockfile.
//      Wrapped around read-modify-write sequences so two concurrent processes
//      can't both observe v=N and clobber. NOT a kernel-grade lock — multi-
//      machine NFS scenarios will need stronger primitives (out of scope).
//
// In-process StaleDeliberationError still catches the in-process race; this
// adds the cross-process layer that the in-process OCC cannot see.
// ─────────────────────────────────────────────────────────────────────────────

function atomicWriteSync(filePath, body) {
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

const LOCK_SUFFIX = ".lock";
const LOCK_DEFAULT_TIMEOUT_MS = 500;
const LOCK_DEFAULT_INTERVAL_MS = 10;
// Stale-lock threshold: a lockfile this old is presumed orphaned by a crashed
// process; the next acquirer sweeps it before reattempting. Conservative — we
// do not want to break a legitimate slow writer.
const LOCK_STALE_MS = 30_000;
const TMP_STALE_MS = 60_000;

function withFileLockSync(filePath, op, opts = {}) {
  const lockPath = filePath + LOCK_SUFFIX;
  const timeoutMs = opts.timeoutMs ?? LOCK_DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? LOCK_DEFAULT_INTERVAL_MS;
  const start = Date.now();
  let acquired = false;
  let staleSwept = false;

  while (!acquired) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
      try { fs.writeSync(fd, String(process.pid)); } catch {}
      try { fs.closeSync(fd); } catch {}
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Try a one-shot stale sweep: if the lockfile predates LOCK_STALE_MS, the
      // owning process almost certainly crashed mid-RMW. Remove and retry.
      if (!staleSwept) {
        staleSwept = true;
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue; // immediate retry
          }
        } catch {
          // race: lock vanished between EEXIST and stat — retry
          continue;
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`checkpoint lock contention on ${path.basename(filePath)}`);
      }
      // Brief sleep — checkpoint RMW is fast; busy-wait keeps us off the
      // event loop turn boundary so a sibling sync writer in the same
      // process can't deadlock us.
      const until = Date.now() + intervalMs;
      while (Date.now() < until) { /* tiny busy wait */ }
    }
  }

  try {
    return op();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

// Resolve the on-disk path for a checkpoint id. Validates that the result
// stays inside getDir() so a malicious id (e.g. "../../etc/passwd") can't
// escape — defense in depth; callers already constrain id at the API edge.
function checkpointPath(id) {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("checkpoint id must be a non-empty string");
  }
  const dir = getDir();
  const filePath = path.join(dir, `${id}.json`);
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(filePath);
  if (
    resolvedFile !== path.join(resolvedDir, `${id}.json`) ||
    !resolvedFile.startsWith(resolvedDir + path.sep)
  ) {
    throw new Error(`checkpoint id escapes checkpoints dir: ${id}`);
  }
  return filePath;
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

  const filePath = checkpointPath(checkpoint.id);
  // Plain save() is a single write — atomic rename alone suffices. The
  // read-modify-write helpers (update/addCompletedAgent/addPendingAgent)
  // wrap save() in withFileLockSync to serialize cross-process RMW.
  atomicWriteSync(filePath, JSON.stringify(checkpoint, null, 2) + "\n");
  return checkpoint;
}

export function load(id) {
  const filePath = checkpointPath(id);
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

// Sweep stale `.tmp.*` and `.lock` orphans. A daemon crash mid-RMW can leave
// these behind; on next boot we reclaim anything older than the relevant
// threshold. Live operations (current pid is mid-write/mid-lock) are not
// touched because mtime will be < threshold. Returns the basenames removed
// for observability; idempotent.
export function sweepStale(now = Date.now()) {
  const dir = getDir();
  const removedTmp = [];
  const removedLocks = [];
  if (!fs.existsSync(dir)) return { removedTmp, removedLocks };

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { removedTmp, removedLocks };
  }

  // Match the EXACT atomic-write tmp pattern (`<id>.json.tmp.<pid>.<hex>`) so
  // we never accidentally delete a checkpoint that happens to contain ".tmp."
  // in its id (e.g. `weird.tmp.json`). Pid is digits, suffix is hex bytes.
  const TMP_RE = /\.json\.tmp\.\d+\.[0-9a-f]+$/;
  for (const entry of entries) {
    const isTmp = TMP_RE.test(entry);
    const isLock = entry.endsWith(LOCK_SUFFIX);
    if (!isTmp && !isLock) continue;

    const fullPath = path.join(dir, entry);
    let st;
    try {
      st = fs.statSync(fullPath);
    } catch {
      continue;
    }
    const age = now - st.mtimeMs;
    const threshold = isTmp ? TMP_STALE_MS : LOCK_STALE_MS;
    if (age <= threshold) continue;

    try {
      fs.unlinkSync(fullPath);
      if (isTmp) removedTmp.push(entry);
      else removedLocks.push(entry);
    } catch (err) {
      console.warn(`[checkpoint] sweepStale unlink failed for ${entry}: ${err.message}`);
    }
  }
  return { removedTmp, removedLocks };
}

export function remove(id) {
  const filePath = checkpointPath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

export function update(id, updates) {
  const filePath = checkpointPath(id);
  return withFileLockSync(filePath, () => {
    const existing = load(id);
    if (!existing) return null;
    const merged = { ...existing, ...updates, id, updatedAt: Date.now() };
    save(merged);
    return merged;
  });
}

export function addCompletedAgent(checkpointId, agentData) {
  const filePath = checkpointPath(checkpointId);
  return withFileLockSync(filePath, () => {
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
  });
}

export function addPendingAgent(checkpointId, agentData) {
  const filePath = checkpointPath(checkpointId);
  return withFileLockSync(filePath, () => {
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
  });
}
