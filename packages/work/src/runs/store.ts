import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function RUNS_DIR() {
  const wc = require("@zana-ai/core").project.workspaceContext;
  if (wc.isInitialized()) return wc.getProjectPaths().runsDir;
  // Read-side fallback. The write paths (saveRun / deleteRun) gate on
  // workspaceContext.isInitialized() and throw WorkspaceNotInitializedError
  // before reaching this branch — so this fallback only ever serves reads
  // (listRuns / getRun) of legacy global-scope state.
  return path.join(os.homedir(), ".zana", "runs");
}

/**
 * Throws WorkspaceNotInitializedError when no workspace is initialized.
 * Use ONLY from write paths — reads are intentionally tolerant of the
 * global fallback so legacy host-global runs stay inspectable.
 */
function assertWorkspaceForWrite(operation: string) {
  const core = require("@zana-ai/core");
  const ctx = core.project.workspaceContext;
  if (!ctx.isInitialized()) {
    const ErrCtor = ctx.WorkspaceNotInitializedError;
    throw new ErrCtor({
      operation,
      path: path.join(os.homedir(), ".zana", "runs"),
    });
  }
}

function ensureDir() {
  fs.mkdirSync(RUNS_DIR(), { recursive: true });
}

function migrateRun(run) {
  if (!run || typeof run !== "object") return run;
  if (run.hiveId !== undefined && run.daemonId === undefined) {
    run.daemonId = run.hiveId;
    delete run.hiveId;
  }
  if (Array.isArray(run.subHives) && !Array.isArray(run.subDaemons)) {
    run.subDaemons = run.subHives;
    delete run.subHives;
  }
  return run;
}

export function listRuns({ limit = 50, offset = 0, status } = {}) {
  ensureDir();
  try {
    const files = fs.readdirSync(RUNS_DIR()).filter((f) => f.endsWith(".json"));
    let runs = files.map((f) => {
      try {
        return migrateRun(JSON.parse(fs.readFileSync(path.join(RUNS_DIR(), f), "utf8")));
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (status) {
      runs = runs.filter((r) => r.status === status);
    }

    runs.sort((a, b) => b.startedAt - a.startedAt);
    return runs.slice(offset, offset + limit);
  } catch {
    return [];
  }
}

export function getRun(id) {
  if (!id) return null;
  ensureDir();
  const filePath = path.join(RUNS_DIR(), `${id}.json`);
  try {
    return migrateRun(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function saveRun(run) {
  // Tenant isolation gate: refuse to write into the global ~/.zana/runs
  // fallback when no workspace is bootstrapped — runs can carry tenant
  // context (artifact ids, deliberation refs) that must not leak across
  // workspaces sharing the host.
  assertWorkspaceForWrite("saveRun");
  ensureDir();
  const filePath = path.join(RUNS_DIR(), `${run.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(run, null, 2) + "\n", "utf8");
  return run;
}

export function deleteRun(id) {
  if (!id) return false;
  // Tenant isolation gate: deletes are writes; same rationale as saveRun.
  assertWorkspaceForWrite("deleteRun");
  const filePath = path.join(RUNS_DIR(), `${id}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

