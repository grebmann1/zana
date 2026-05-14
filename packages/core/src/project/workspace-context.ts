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
      tmpDir: path.join(projectDir, "tmp"),
      configPath: path.join(projectDir, "config.json"),
    }),
  };
}

