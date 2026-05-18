// Creates the .zana/ directory structure for a project
// Called on first run or via `zana init`

import * as fs from "fs";
import * as path from "path";

export const PROJECT_DIR = ".zana";

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

const SCHEDULER_EXAMPLE_HEADER = `# This is an example Zana schedule. Rename from .yml.example to .yml
# (or use \`zana schedule create\`) to enable it. Comments are preserved
# on save — feel free to edit fields by hand. The \`status\` block at
# the bottom is managed by the daemon.\n`;

const SCHEDULER_EXAMPLES: Array<{ filename: string; body: string }> = [
  {
    filename: "daily-test-audit.yml.example",
    body: `${SCHEDULER_EXAMPLE_HEADER}
id: example-daily-test-audit
name: Daily test gap audit
description: Spawn the test-writer profile once a day to scan for files that lack tests.
enabled: false

schedule:
  cron: "0 2 * * *"   # every day at 02:00 (host TZ)

action:
  type: spawn-agent
  profileId: test-writer
  prompt: |
    Scan the project for files that lack accompanying tests. Report the
    top 5 gaps in priority order, including file path and a one-line
    rationale for why each is risky to leave uncovered.
`,
  },
  {
    filename: "weekly-security-scan.yml.example",
    body: `${SCHEDULER_EXAMPLE_HEADER}
id: example-weekly-security-scan
name: Weekly OWASP-ish security scan
description: Spawn the security-reviewer profile every Sunday at 03:00.
enabled: false

schedule:
  cron: "0 3 * * 0"   # Sunday 03:00

action:
  type: spawn-agent
  profileId: security-reviewer
  prompt: |
    Walk the project for OWASP Top 10 risks: injection, broken auth,
    sensitive data exposure, XXE, broken access control, security
    misconfiguration, XSS, insecure deserialization, vulnerable deps,
    insufficient logging. Produce a prioritized report.
`,
  },
  {
    filename: "hourly-build-health.yml.example",
    body: `${SCHEDULER_EXAMPLE_HEADER}
id: example-hourly-build-health
name: Hourly build health
description: Run the runtime build every hour to catch regressions early.
enabled: false

schedule:
  every: 1h           # also accepts 5m, 30s, 2d, 500ms

action:
  type: command
  command: npm run build:runtime
`,
  },
];

function writeSchedulerExamples(projectPath: string, force: boolean) {
  const examplesDir = path.join(projectPath, "scheduler", "examples");
  fs.mkdirSync(examplesDir, { recursive: true });
  for (const ex of SCHEDULER_EXAMPLES) {
    const dest = path.join(examplesDir, ex.filename);
    if (fs.existsSync(dest) && !force) continue;
    fs.writeFileSync(dest, ex.body, "utf8");
  }
}

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
    createdBy: "zana-init",
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
 * @returns {{ created: boolean, projectPath: string }}
 */
export function initProjectDir(workspaceRoot, options = {}) {
  const { force = false, silent = false } = options;
  const projectPath = path.join(workspaceRoot, PROJECT_DIR);
  const configPath = path.join(projectPath, "config.json");

  // Create .zana/ root
  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath, { recursive: true });
  }

  // Create subdirectories
  for (const sub of SUBDIRS) {
    const dirPath = path.join(projectPath, sub);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  // Drop scheduler example YAMLs (idempotent — won't overwrite unless forced)
  try {
    writeSchedulerExamples(projectPath, force);
  } catch (err: any) {
    if (!silent) console.warn("[init] failed to write scheduler examples:", err?.message || err);
  }

  // Write .gitignore (always overwrite — it's declarative)
  fs.writeFileSync(path.join(projectPath, ".gitignore"), GITIGNORE_CONTENT, "utf8");

  // Write config.json (only if missing or force)
  if (!fs.existsSync(configPath) || force) {
    const config = buildDefaultConfig(workspaceRoot);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  if (!silent) {
    console.log(`\x1b[36mzana\x1b[0m Initialized .zana/ in ${workspaceRoot}`);
  }

  return { created: true, projectPath };
}

/**
 * Check whether .zana/ exists with the required structure.
 *
 * @param {string} workspaceRoot
 * @returns {boolean}
 */
export function isProjectInitialized(workspaceRoot) {
  const projectPath = path.join(workspaceRoot, PROJECT_DIR);
  const configPath = path.join(projectPath, "config.json");

  if (!fs.existsSync(projectPath) || !fs.existsSync(configPath)) {
    return false;
  }

  // Verify all required subdirectories exist
  for (const sub of SUBDIRS) {
    if (!fs.existsSync(path.join(projectPath, sub))) {
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
export function getProjectManifest(workspaceRoot) {
  const configPath = path.join(workspaceRoot, PROJECT_DIR, "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

