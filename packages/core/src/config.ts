import * as path from "node:path";
import * as os from "node:os";

const ZANA_DIR = path.join(os.homedir(), ".zana");

// NOTE: Project-local paths (tickets, sprints, artifacts, sessions, events,
// runs, scheduler, tmp) live in project/workspace-context.js. Use
// `core.project.workspaceContext.getProjectPaths()` at call sites — this
// module only exports global (host-scoped) paths.

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

  // ─── Global-only helper paths (no per-workspace equivalent) ─────────────────
  PERSIST_DIR: path.join(ZANA_DIR, "persistence"),
  SCRATCHPAD_DIR: path.join(ZANA_DIR, "scratchpad"),
};
