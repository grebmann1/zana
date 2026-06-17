/**
 * workspace-context.js — Singleton that manages workspace path resolution.
 *
 * All project-local stores consume paths from here.
 * Global paths (profiles, teams, plugins, etc.) remain in config.js.
 */

import * as path from "node:path";
import * as fs from "node:fs";

let _workspaceRoot = null;
let _projectDir = null;

/**
 * Thrown when a tenant-isolated operation is attempted against an
 * uninitialized workspace context. Callers can `instanceof`-check or
 * dispatch on `code === "WORKSPACE_NOT_INITIALIZED"`.
 *
 * Used by the deliberation runtime (CAS writes + checkpoint writes with
 * kind="deliberation") to refuse silent fallback into the global
 * `~/.zana/` namespace, which would let two workspaces share
 * deliberations while running independent quorum/TTL settings.
 */
export class WorkspaceNotInitializedError extends Error {
  code = "WORKSPACE_NOT_INITIALIZED";
  operation;
  path;
  requestedKind;
  constructor(opts) {
    const op = opts && opts.operation ? opts.operation : "write";
    const p = opts && typeof opts.path === "string" ? opts.path : "";
    const kind = opts && typeof opts.requestedKind === "string" ? opts.requestedKind : undefined;
    const detail = kind ? ` (kind=${kind})` : "";
    super(
      `workspace not initialized — refusing tenant-isolated ${op}${detail}` +
        (p ? ` at ${p}` : "") +
        ". Run `zana init` (or call workspaceContext.init) before deliberation operations.",
    );
    this.name = "WorkspaceNotInitializedError";
    this.operation = op;
    this.path = p;
    if (kind !== undefined) this.requestedKind = kind;
  }
}

/**
 * Walk up from startPath looking for an existing .zana/ directory.
 * Stops at filesystem root or when a .git directory is found (project boundary).
 * If not found, returns path.join(startPath, '.zana') as the expected location.
 */
export function resolveProjectDir(startPath) {
  let current = path.resolve(startPath);

  while (true) {
    const candidateZana = path.join(current, ".zana");
    if (fs.existsSync(candidateZana) && fs.statSync(candidateZana).isDirectory()) return candidateZana;

    // Stop if we hit a .git boundary (this is the project root)
    const gitDir = path.join(current, ".git");
    if (fs.existsSync(gitDir)) {
      break;
    }

    const parent = path.dirname(current);

    // Stop at filesystem root
    if (parent === current) {
      break;
    }

    current = parent;
  }

  // Not found — return the expected location at startPath
  return path.join(startPath, ".zana");
}

/**
 * Initialize the workspace context. Call once on app start with the resolved
 * workspace path.
 */
export function init(workspaceRoot) {
  if (!workspaceRoot) {
    throw new Error("workspace-context: workspaceRoot is required");
  }
  _workspaceRoot = path.resolve(workspaceRoot);
  _projectDir = resolveProjectDir(_workspaceRoot);
}

/**
 * Returns the workspace root (e.g., /path/to/project).
 */
export function getWorkspaceRoot() {
  if (!_workspaceRoot) {
    throw new Error("workspace-context: not initialized. Call init() first.");
  }
  return _workspaceRoot;
}

/**
 * Returns the project state directory path (e.g., /path/to/project/.zana).
 */
export function getProjectDir() {
  if (!_projectDir) {
    throw new Error("workspace-context: not initialized. Call init() first.");
  }
  return _projectDir;
}

/**
 * Returns an object with all project-local paths derived from the project state dir.
 */
export function getProjectPaths() {
  const projectDir = getProjectDir();

  return {
    projectDir,
    ticketsDir: path.join(projectDir, "tickets"),
    sprintsDir: path.join(projectDir, "sprints"),
    artifactsDir: path.join(projectDir, "artifacts"),
    plansDir: path.join(projectDir, "plans"),
    auditDir: path.join(projectDir, "audit"),
    sessionsDir: path.join(projectDir, "sessions"),
    runsDir: path.join(projectDir, "runs"),
    eventsDir: path.join(projectDir, "events"),
    schedulerDir: path.join(projectDir, "scheduler"),
    checkpointsDir: path.join(projectDir, "checkpoints"),
    tmpDir: path.join(projectDir, "tmp"),
    configPath: path.join(projectDir, "config.json"),
  };
}

/**
 * True after init() has been called.
 */
export function isInitialized() {
  return _workspaceRoot !== null;
}

/**
 * Test-only — drops the singleton back to its pre-init state. Production
 * code MUST NOT call this; the singleton is process-global by design and
 * resetting it mid-flight would void tenant isolation. Exposed solely so
 * tests can simulate "workspace not yet bootstrapped" between cases.
 */
export function _resetForTesting() {
  _workspaceRoot = null;
  _projectDir = null;
}

/**
 * Factory: create an isolated workspace context for a given directory.
 * Used for per-window contexts in multi-window mode.
 * Returns a plain object with the same read API as the singleton.
 */
export function createForWorkspace(dir) {
  const resolved = path.resolve(dir);
  const projectDir = resolveProjectDir(resolved);

  return {
    getWorkspaceRoot: () => resolved,
    getProjectDir: () => projectDir,
    isInitialized: () => fs.existsSync(projectDir),
    getProjectPaths: () => ({
      projectDir,
      ticketsDir: path.join(projectDir, "tickets"),
      sprintsDir: path.join(projectDir, "sprints"),
      artifactsDir: path.join(projectDir, "artifacts"),
      plansDir: path.join(projectDir, "plans"),
      auditDir: path.join(projectDir, "audit"),
      sessionsDir: path.join(projectDir, "sessions"),
      runsDir: path.join(projectDir, "runs"),
      eventsDir: path.join(projectDir, "events"),
      schedulerDir: path.join(projectDir, "scheduler"),
      checkpointsDir: path.join(projectDir, "checkpoints"),
      tmpDir: path.join(projectDir, "tmp"),
      configPath: path.join(projectDir, "config.json"),
    }),
  };
}

