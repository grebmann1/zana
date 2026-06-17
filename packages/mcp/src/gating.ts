// Tool-visibility gates for the Zana MCP server.
//
// Two flags filter the public tool surface independently:
//
//   ZANA_DAEMON_TOOLS     — expose the daemon-path orchestration tools
//                            (agent/team lifecycle, autopilot, deliberation,
//                            P2P). ON by default — the daemon path is
//                            first-class. Set ZANA_DAEMON_TOOLS=0 (or =false)
//                            for the lean native-only surface, where these
//                            flows are covered by Agent + SendMessage and the
//                            slash commands. See DAEMON_GATED_TOOL_NAMES below
//                            and ADR docs/decisions/0005.
//   ZANA_MASTER_MODE=true — required (with ZANA_SWARM_EXPERIMENTAL) to expose
//                            `zana_swarm_*` (multi-daemon control). Off by
//                            default; see registrations/swarm.ts.
//   ZANA_*_EXPERIMENTAL    — frozen subsystems whose tools are NOT registered
//                            by default (ADR 0009). Each is dormant code kept
//                            for a future call, surfaced only behind its flag:
//                              ZANA_SWARM_EXPERIMENTAL   → zana_swarm_*
//                              ZANA_PLANNER_EXPERIMENTAL → zana_plan_create (GOAP)
//                              ZANA_MEMORY_EXPERIMENTAL  → zana_memory_store/search
//
// Flags are read once at module load — restart the server to flip them.

export const ZANA_MASTER_MODE = process.env.ZANA_MASTER_MODE === "true";
export const ZANA_DAEMON_TOOLS =
  process.env.ZANA_DAEMON_TOOLS !== "0" && process.env.ZANA_DAEMON_TOOLS !== "false";

const flagOn = (name: string) => process.env[name] === "1" || process.env[name] === "true";
export const ZANA_SWARM_EXPERIMENTAL = flagOn("ZANA_SWARM_EXPERIMENTAL");
export const ZANA_PLANNER_EXPERIMENTAL = flagOn("ZANA_PLANNER_EXPERIMENTAL");
export const ZANA_MEMORY_EXPERIMENTAL = flagOn("ZANA_MEMORY_EXPERIMENTAL");

// Frozen-subsystem tools (ADR 0009): filtered out of tools/list AND rejected at
// tools/call unless the corresponding ZANA_*_EXPERIMENTAL flag is set. Maps a
// tool name → the env var that re-enables it. Multi-daemon (zana_swarm_*) is
// handled in registrations/swarm.ts (needs MASTER_MODE too), so it is not here.
export const EXPERIMENTAL_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ["zana_plan_create", "ZANA_PLANNER_EXPERIMENTAL"],
  ["zana_memory_store", "ZANA_MEMORY_EXPERIMENTAL"],
  ["zana_memory_search", "ZANA_MEMORY_EXPERIMENTAL"],
]);

// True when a frozen tool should be hidden/rejected (its flag is off).
export function isFrozen(toolName: string): boolean {
  const flag = EXPERIMENTAL_TOOL_NAMES.get(toolName);
  if (!flag) return false;
  return !flagOn(flag);
}

// Tool names that are only useful from a long-lived daemon process. Inside a
// Claude Code chat the same flows are covered by `Agent({ run_in_background })`
// + `SendMessage` and the `/zana:autopilot`, `/zana:council`, `/zana:team`
// slash commands — so the MCP variants are dead weight in the native path.
// When ZANA_DAEMON_TOOLS is unset, these are filtered out of `tools/list` AND
// rejected at `tools/call` time (so a client cannot bypass the visibility
// filter by invoking the tool by name directly).
export const DAEMON_GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Agent lifecycle (covered natively by Agent + SendMessage)
  "zana_spawn_agent",
  "zana_spawn_agent_validated",
  "zana_oneshot_query",
  "zana_list_agents",
  "zana_agent_status",
  "zana_agent_result",
  "zana_kill_agent",
  // Team lifecycle (covered by /zana:team)
  "zana_start_team",
  "zana_stop_team",
  "zana_team_status",
  "zana_list_running_teams",
  // P2P agent comms (covered by SendMessage between named subagents)
  "zana_ask_agent",
  "zana_check_inbox",
  "zana_send_ack",
  // Autopilot (covered by /zana:autopilot)
  "zana_autopilot_goal_driven",
  "zana_autopilot_goal_status",
  "zana_autopilot_goal_list",
  "zana_autopilot_goal_cancel",
  // Deliberation / council (covered by /zana:council)
  "zana_deliberate",
  "zana_deliberate_cancel",
  "zana_deliberation_status",
  "zana_deliberation_list",
  "zana_deliberation_nudge",
  "zana_deliberation_override",
]);
