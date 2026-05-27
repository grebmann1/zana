/**
 * Host detection — determine whether Zana is running inside Claude Code
 * or in a generic MCP-shell / standalone environment.
 *
 * Used by the hook installer (which must skip silently on non-Claude hosts)
 * and the spawner (which selects the worker binary). Cheap to call; do not
 * cache the result — `~/.claude/` can be created mid-session by an installer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HostType = "claude" | "generic";

export function isClaudeHost(): boolean {
  if (process.env.ZANA_HOST_OVERRIDE === "generic") return false;
  if (process.env.ZANA_HOST_OVERRIDE === "claude") return true;
  return fs.existsSync(path.join(os.homedir(), ".claude"));
}

export function getHostType(): HostType {
  return isClaudeHost() ? "claude" : "generic";
}
