// Multi-daemon swarm control — FROZEN (ADR 0009). Requires BOTH
// ZANA_MASTER_MODE=true AND ZANA_SWARM_EXPERIMENTAL=1 to surface. Multi-daemon
// coordination is dormant code kept for a future call, not a default feature.
//
// When the gate is closed the `tools` array is empty, so these tools never
// appear in `tools/list`. Handlers are still registered (and will work for
// internal callers) but the visibility filter prevents external invocation.
// NOTE: this freezes only the swarm SPAWNER surface (zana_swarm_*). The swarm
// package's router/events (the single-daemon agent P2P inbox powering
// zana_send_message / zana_check_inbox) are unaffected — they are core plumbing.

import { ZANA_MASTER_MODE, ZANA_SWARM_EXPERIMENTAL } from "../gating";
import type { ToolDomain } from "../types";

const SWARM_TOOLS = [
  {
    name: "zana_swarm_spawn",
    description:
      "Spawn a new child daemon (headless team). The child daemon runs as a child process and can be controlled via instructions.",
    inputSchema: {
      type: "object",
      properties: {
        teamId: {
          type: "string",
          description: "Team ID to start in the child daemon (optional — omit to spawn a single orchestrator)",
        },
        workspace: {
          type: "string",
          description: "Working directory for the child daemon (defaults to current workspace)",
        },
        prompt: { type: "string", description: "Initial prompt/task for the child daemon" },
      },
    },
  },
  {
    name: "zana_swarm_list",
    description: "List all spawned child daemons with their status, ports, and team info.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "zana_swarm_instruct",
    description:
      "Send an instruction to a child daemon's team lead. Instructions flow DOWN only (master → team lead → workers).",
    inputSchema: {
      type: "object",
      properties: {
        daemonId: { type: "string", description: "Child daemon ID to instruct" },
        message: { type: "string", description: "Instruction message for the team lead" },
      },
      required: ["daemonId", "message"],
    },
  },
  {
    name: "zana_swarm_stop",
    description: "Stop a child daemon. Sends SIGTERM to the child process.",
    inputSchema: {
      type: "object",
      properties: { daemonId: { type: "string", description: "Child daemon ID to stop" } },
      required: ["daemonId"],
    },
  },
  {
    name: "zana_swarm_broadcast",
    description: "Send a message to ALL running child daemons. Each team lead receives the instruction.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to broadcast to all child daemon team leads" },
      },
      required: ["message"],
    },
  },
  {
    name: "zana_swarm_poll_events",
    description: "Poll events from child daemons (progress reports, decision requests, completions, errors).",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "number",
          description: "Timestamp (ms) — only return events after this time. Omit for all.",
        },
      },
    },
  },
];

export const swarm: ToolDomain = {
  tools: ZANA_MASTER_MODE && ZANA_SWARM_EXPERIMENTAL ? SWARM_TOOLS : [],

  handlers: {
    zana_swarm_spawn: (args, { callCore }) =>
      callCore("swarm_spawn", { teamId: args.teamId, workspace: args.workspace, prompt: args.prompt }),
    zana_swarm_list: (_args, { callCore }) => callCore("swarm_list"),
    zana_swarm_instruct: (args, { callCore }) =>
      callCore("swarm_instruct", { daemonId: args.daemonId, message: args.message }),
    zana_swarm_stop: (args, { callCore }) => callCore("swarm_stop", { daemonId: args.daemonId }),
    zana_swarm_broadcast: (args, { callCore }) => callCore("swarm_broadcast", { message: args.message }),
    zana_swarm_poll_events: (args, { callCore }) => callCore("swarm_poll_events", { since: args.since }),
  },
};
