import * as path from "node:path";
import * as os from "node:os";
import * as ctx from "./project/workspace-context.js";

const ZANA_DIR = path.join(os.homedir(), ".zana");

// NOTE: Project-local paths (tickets, sprints, artifacts, sessions, events,
// runs, scheduler, tmp) now live in project/workspace-context.js. Import from
// there for new code. The deprecated getters below provide backward compatibility
// during migration.

module.exports = {
  // ─── Global paths ───────────────────────────────────────────────────────────
  ZANA_DIR,
  PROFILES_DIR: path.join(ZANA_DIR, "profiles"),
  TEAMS_DIR: path.join(ZANA_DIR, "teams"),
  SKILLS_DIR: path.join(ZANA_DIR, "skills"),
  PLUGINS_DIR: path.join(ZANA_DIR, "plugins"),
  DAEMONS_DIR: path.join(ZANA_DIR, "daemons"),
  BIN_DIR: path.join(ZANA_DIR, "bin"),
  SETTINGS_PATH: path.join(ZANA_DIR, "settings.json"),
  RECENT_WORKSPACES_PATH: path.join(ZANA_DIR, "recent-workspaces.json"),
  CLAUDE_SETTINGS_BACKUP: path.join(os.homedir(), ".claude", "settings.json.bak.zana"),

  // ─── Constants ──────────────────────────────────────────────────────────────
  DEFAULT_HOOK_PORT: 47400,
  MAX_CONCURRENT_AGENTS: 10,

  // ─── DEPRECATED: Use project/workspace-context.js getProjectPaths() instead ─
  // These getters provide backward compatibility for existing imports.
  // They will be removed in a future sprint.

  get TICKETS_DIR() {
    /* hoisted */
    return ctx.isInitialized() ? ctx.getProjectPaths().ticketsDir : path.join(ZANA_DIR, "tickets");
  },

  get SPRINTS_DIR() {
    /* hoisted */
    return ctx.isInitialized() ? ctx.getProjectPaths().sprintsDir : path.join(ZANA_DIR, "sprints");
  },

  get ARTIFACTS_DIR() {
    /* hoisted */
    return ctx.isInitialized() ? ctx.getProjectPaths().artifactsDir : path.join(ZANA_DIR, "artifacts");
  },

  get SESSIONS_DIR() {
    /* hoisted */
    return ctx.isInitialized() ? ctx.getProjectPaths().sessionsDir : path.join(ZANA_DIR, "sessions");
  },

  get EVENTS_DIR() {
    /* hoisted */
    return ctx.isInitialized() ? ctx.getProjectPaths().eventsDir : path.join(ZANA_DIR, "events");
  },

  get RUNS_DIR() {
    /* hoisted */
    return ctx.isInitialized() ? ctx.getProjectPaths().runsDir : path.join(ZANA_DIR, "runs");
  },

  get SCHEDULER_DIR() {
    /* hoisted */
    return ctx.isInitialized() ? ctx.getProjectPaths().schedulerDir : path.join(ZANA_DIR, "scheduler");
  },

  get PERSIST_DIR() {
    // No direct equivalent in workspace-context; falls back to global.
    return path.join(ZANA_DIR, "persistence");
  },

  get TMP_DIR() {
    /* hoisted */
    return ctx.isInitialized() ? ctx.getProjectPaths().tmpDir : path.join(ZANA_DIR, "tmp");
  },

  get SCRATCHPAD_DIR() {
    // No direct equivalent in workspace-context; falls back to global.
    return path.join(ZANA_DIR, "scratchpad");
  },
};
