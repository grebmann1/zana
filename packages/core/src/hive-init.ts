// Creates the .zana/ directory structure for a project
// Called on first run or via `hive init`

import * as fs from "fs";
import * as path from "path";

export const HIVE_DIR = ".zana";

const SUBDIRS = [
  "tickets",
  "sprints",
  "artifacts",
  "plans",
  "audit",
  "sessions",
  "runs",
  "events",
  "scheduler",
  "tmp",
];

const GITIGNORE_CONTENT = `# Transient runtime data — not committed
audit/
sessions/
runs/
events/
tmp/

# Everything else is committed by default:
# tickets/, sprints/, artifacts/, plans/, scheduler/, config.json
`;

/**
 * Derive a project name from the workspace root.
 * 1. If package.json exists, use its "name" field.
 * 2. Otherwise fall back to the directory basename.
 */
function deriveProjectName(workspaceRoot) {
  const pkgPath = path.join(workspaceRoot, "package.json");
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name) return pkg.name;
    }
  } catch {
    // Fall through to basename
  }
  return path.basename(workspaceRoot);
}

/**
 * Build the default config.json content for a new .zana/ directory.
 */
function buildDefaultConfig(workspaceRoot) {
  return {
    version: 1,
    name: deriveProjectName(workspaceRoot),
    createdAt: new Date().toISOString(),
    createdBy: "hive-init",
    settings: {
      maxConcurrentAgents: 10,
      hookPort: 47400,
      autoArchiveSessions: true,
      archiveAfterDays: 30,
    },
  };
}

/**
 * Initialize the .zana/ directory structure in a workspace.
 *
 * @param {string} workspaceRoot - Absolute path to the project root.
 * @param {{ force?: boolean, silent?: boolean }} [options]
 * @returns {{ created: boolean, hivePath: string }}
 */
export function initHiveDir(workspaceRoot, options = {}) {
  const { force = false, silent = false } = options;
  const hivePath = path.join(workspaceRoot, HIVE_DIR);
  const configPath = path.join(hivePath, "config.json");

  // Create .zana/ root
  if (!fs.existsSync(hivePath)) {
    fs.mkdirSync(hivePath, { recursive: true });
  }

  // Create subdirectories
  for (const sub of SUBDIRS) {
    const dirPath = path.join(hivePath, sub);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  // Write .gitignore (always overwrite — it's declarative)
  fs.writeFileSync(path.join(hivePath, ".gitignore"), GITIGNORE_CONTENT, "utf8");

  // Write config.json (only if missing or force)
  if (!fs.existsSync(configPath) || force) {
    const config = buildDefaultConfig(workspaceRoot);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  if (!silent) {
    console.log(`\x1b[36mhive\x1b[0m Initialized .zana/ in ${workspaceRoot}`);
  }

  return { created: true, hivePath };
}

/**
 * Check whether .zana/ exists with the required structure.
 *
 * @param {string} workspaceRoot
 * @returns {boolean}
 */
export function isHiveInitialized(workspaceRoot) {
  const hivePath = path.join(workspaceRoot, HIVE_DIR);
  const configPath = path.join(hivePath, "config.json");

  if (!fs.existsSync(hivePath) || !fs.existsSync(configPath)) {
    return false;
  }

  // Verify all required subdirectories exist
  for (const sub of SUBDIRS) {
    if (!fs.existsSync(path.join(hivePath, sub))) {
      return false;
    }
  }

  return true;
}

/**
 * Read and parse the .zana/config.json manifest.
 *
 * @param {string} workspaceRoot
 * @returns {object|null} Parsed config or null if not found.
 */
export function getHiveManifest(workspaceRoot) {
  const configPath = path.join(workspaceRoot, HIVE_DIR, "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

