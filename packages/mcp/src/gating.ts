// Tool-visibility gates for the Zana MCP server.
//
// Two flags filter the public tool surface independently:
//
//   ZANA_DAEMON_TOOLS=1   — re-expose tools that duplicate native Claude Code
//                            primitives. Default Claude Code installs run
//                            without it; headless / CI / cron callers opt back
//                            in. See DAEMON_GATED_TOOL_NAMES below.
//   ZANA_MASTER_MODE=true — expose `zana_swarm_*` (multi-daemon control).
//                            Off by default; see registrations/swarm.ts.
//
// Both flags are read once at module load — restart the server to flip them.

export const ZANA_MASTER_MODE = process.env.ZANA_MASTER_MODE === "true";
export const ZANA_DAEMON_TOOLS =
  process.env.ZANA_DAEMON_TOOLS === "1" || process.env.ZANA_DAEMON_TOOLS === "true";

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
