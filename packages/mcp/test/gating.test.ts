// Unit tests for gating.ts — DAEMON_GATED_TOOL_NAMES set membership and
// the ZANA_DAEMON_TOOLS / ZANA_MASTER_MODE flag defaults.
//
// Strategy: import the module directly in the test process (env vars not set
// by this test suite, so flags reflect the "default install" state).  The
// DAEMON_GATED_TOOL_NAMES constant is purely static data and is safe to
// validate here without any subprocess overhead.

import { describe, it, expect } from "vitest";
import {
  DAEMON_GATED_TOOL_NAMES,
  ZANA_DAEMON_TOOLS,
  ZANA_MASTER_MODE,
} from "../src/gating.ts";

// The canonical list of daemon-gated tool names (must stay in sync with
// gating.ts).  If a tool is added or removed, this test will catch it.
const EXPECTED_DAEMON_GATED: ReadonlyArray<string> = [
  // Agent lifecycle
  "zana_spawn_agent",
  "zana_spawn_agent_validated",
  "zana_oneshot_query",
  "zana_list_agents",
  "zana_agent_status",
  "zana_agent_result",
  "zana_kill_agent",
  // Team lifecycle
  "zana_start_team",
  "zana_stop_team",
  "zana_team_status",
  "zana_list_running_teams",
  // P2P agent comms
  "zana_ask_agent",
  "zana_check_inbox",
  "zana_send_ack",
  // Autopilot
  "zana_autopilot_goal_driven",
  "zana_autopilot_goal_status",
  "zana_autopilot_goal_list",
  "zana_autopilot_goal_cancel",
  // Deliberation / council
  "zana_deliberate",
  "zana_deliberate_cancel",
  "zana_deliberation_status",
  "zana_deliberation_list",
  "zana_deliberation_nudge",
  "zana_deliberation_override",
];

describe("DAEMON_GATED_TOOL_NAMES", () => {
  it("contains exactly 24 tool names", () => {
    expect(DAEMON_GATED_TOOL_NAMES.size).toBe(24);
  });

  it("contains every expected daemon-gated tool", () => {
    for (const name of EXPECTED_DAEMON_GATED) {
      expect(DAEMON_GATED_TOOL_NAMES.has(name), `expected '${name}' in DAEMON_GATED_TOOL_NAMES`).toBe(true);
    }
  });

  it("does NOT contain ordinary (ungated) tools", () => {
    const ungated = [
      "zana_ticket_create",
      "zana_ticket_list",
      "zana_memory_store",
      "zana_memory_search",
      "zana_artifact_create",
      "zana_list_teams",
      "zana_save_profile",
    ];
    for (const name of ungated) {
      expect(DAEMON_GATED_TOOL_NAMES.has(name), `'${name}' should NOT be gated`).toBe(false);
    }
  });

  it("does NOT contain swarm tools (those are gated by ZANA_MASTER_MODE separately)", () => {
    const swarmTools = [
      "zana_swarm_spawn",
      "zana_swarm_list",
      "zana_swarm_instruct",
      "zana_swarm_stop",
      "zana_swarm_broadcast",
      "zana_swarm_poll_events",
    ];
    for (const name of swarmTools) {
      expect(DAEMON_GATED_TOOL_NAMES.has(name), `swarm tool '${name}' should not be in DAEMON_GATED_TOOL_NAMES`).toBe(false);
    }
  });
});

describe("ZANA_DAEMON_TOOLS flag", () => {
  it("is true by default (daemon path is first-class; opt out with =0)", () => {
    // Daemon tools are surfaced by default — the flag is only false when the
    // env var is explicitly "0" or "false". In the test runner the var is
    // absent, so the flag is true.
    const val = process.env.ZANA_DAEMON_TOOLS;
    if (val !== "0" && val !== "false") {
      expect(ZANA_DAEMON_TOOLS).toBe(true);
    } else {
      expect(ZANA_DAEMON_TOOLS).toBe(false);
    }
  });
});

describe("ZANA_MASTER_MODE flag", () => {
  it("is false when ZANA_MASTER_MODE env var is not set to 'true'", () => {
    const val = process.env.ZANA_MASTER_MODE;
    if (val !== "true") {
      expect(ZANA_MASTER_MODE).toBe(false);
    }
  });
});
