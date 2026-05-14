const path = require("node:path");
const os = require("node:os");

const HIVE_DIR = path.join(os.homedir(), ".zana");

// NOTE: Project-local paths (tickets, sprints, artifacts, sessions, events,
// runs, scheduler, tmp) now live in workspace-context.js. Import from there
// for new code. The deprecated getters below provide backward compatibility
// during migration.

module.exports = {
  // ─── Global paths ───────────────────────────────────────────────────────────
  HIVE_DIR,
  PROFILES_DIR: path.join(HIVE_DIR, "profiles"),
  TEAMS_DIR: path.join(HIVE_DIR, "teams"),
  SKILLS_DIR: path.join(HIVE_DIR, "skills"),
  PLUGINS_DIR: path.join(HIVE_DIR, "plugins"),
  HIVES_DIR: path.join(HIVE_DIR, "hives"),
  BIN_DIR: path.join(HIVE_DIR, "bin"),
  SETTINGS_PATH: path.join(HIVE_DIR, "settings.json"),
  RECENT_WORKSPACES_PATH: path.join(HIVE_DIR, "recent-workspaces.json"),
  CLAUDE_SETTINGS_BACKUP: path.join(os.homedir(), ".claude", "settings.json.bak.zana"),

  // ─── Constants ──────────────────────────────────────────────────────────────
  DEFAULT_HOOK_PORT: 47400,
  MAX_CONCURRENT_AGENTS: 10,

  // ─── DEPRECATED: Use workspace-context.js getProjectPaths() instead ─────────
  // These getters provide backward compatibility for existing imports.
  // They will be removed in a future sprint.

  get TICKETS_DIR() {
    const ctx = require("./workspace-context");
    return ctx.isInitialized() ? ctx.getProjectPaths().ticketsDir : path.join(HIVE_DIR, "tickets");
  },

  get SPRINTS_DIR() {
    const ctx = require("./workspace-context");
    return ctx.isInitialized() ? ctx.getProjectPaths().sprintsDir : path.join(HIVE_DIR, "sprints");
  },

  get ARTIFACTS_DIR() {
    const ctx = require("./workspace-context");
    return ctx.isInitialized() ? ctx.getProjectPaths().artifactsDir : path.join(HIVE_DIR, "artifacts");
  },

  get SESSIONS_DIR() {
    const ctx = require("./workspace-context");
    return ctx.isInitialized() ? ctx.getProjectPaths().sessionsDir : path.join(HIVE_DIR, "sessions");
  },

  get EVENTS_DIR() {
    const ctx = require("./workspace-context");
    return ctx.isInitialized() ? ctx.getProjectPaths().eventsDir : path.join(HIVE_DIR, "events");
  },

  get RUNS_DIR() {
    const ctx = require("./workspace-context");
    return ctx.isInitialized() ? ctx.getProjectPaths().runsDir : path.join(HIVE_DIR, "runs");
  },

  get SCHEDULER_DIR() {
    const ctx = require("./workspace-context");
    return ctx.isInitialized() ? ctx.getProjectPaths().schedulerDir : path.join(HIVE_DIR, "scheduler");
  },

  get PERSIST_DIR() {
    // No direct equivalent in workspace-context; falls back to global.
    return path.join(HIVE_DIR, "persistence");
  },

  get TMP_DIR() {
    const ctx = require("./workspace-context");
    return ctx.isInitialized() ? ctx.getProjectPaths().tmpDir : path.join(HIVE_DIR, "tmp");
  },

  get SCRATCHPAD_DIR() {
    // No direct equivalent in workspace-context; falls back to global.
    return path.join(HIVE_DIR, "scratchpad");
  },
};
