// Goal-driven autopilot — start / status / list / cancel. Daemon-only.

import type { ToolDomain } from "../types";

// Lazy lookup so the autopilot module can be missing in lighter builds without
// breaking server bootstrap.
function _autopilot(): any {
  const ml = require("@zana-ai/core").modules.loader;
  return ml.getModule?.("autopilot");
}

export const autopilot: ToolDomain = {
  tools: [
    {
      name: "zana_autopilot_goal_driven",
      description:
        "Start a goal-driven task that loops a sequence of agent steps until success criteria are met. Returns the goal ID immediately; run autopilot_goal_status to check progress.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title — what you want to achieve" },
          criteria: {
            type: "string",
            description:
              "Success conditions — what must be true for the goal to be 'done'. The evaluator agent judges these.",
          },
          steps: {
            type: "array",
            description:
              "Ordered list of agent invocations. Each step spawns one agent. On failure, the loop restarts from step 0 with feedback.",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string", description: "Prompt for this step's agent" },
                profile: { type: "string", description: "Profile ID to use" },
              },
              required: ["prompt", "profile"],
            },
          },
        },
        required: ["title", "criteria", "steps"],
      },
    },
    {
      name: "zana_autopilot_goal_status",
      description:
        "Get the status of a goal-driven task by ID. Returns: status (running/completed/failed/exhausted/cancelled), iteration count, latest evaluation result.",
      inputSchema: {
        type: "object",
        properties: { goalId: { type: "string" } },
        required: ["goalId"],
      },
    },
    {
      name: "zana_autopilot_goal_list",
      description: "List all autopilot goals (filterable by status).",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status: running, completed, failed, exhausted, cancelled",
          },
        },
      },
    },
    {
      name: "zana_autopilot_goal_cancel",
      description: "Cancel a running goal.",
      inputSchema: {
        type: "object",
        properties: { goalId: { type: "string" } },
        required: ["goalId"],
      },
    },
  ],

  handlers: {
    zana_autopilot_goal_driven: async (args) => {
      const ap = _autopilot();
      if (!ap?.api) return { error: "autopilot module not available" };
      return await ap.api.setGoal(args);
    },
    zana_autopilot_goal_status: (args) => {
      const ap = _autopilot();
      if (!ap?.api) return { error: "autopilot module not available" };
      return ap.api.getGoal(args.goalId) || { error: "unknown goalId" };
    },
    zana_autopilot_goal_list: (args) => {
      const ap = _autopilot();
      if (!ap?.api) return { error: "autopilot module not available" };
      return ap.api.listGoals(args || {});
    },
    zana_autopilot_goal_cancel: (args) => {
      const ap = _autopilot();
      if (!ap?.api) return { error: "autopilot module not available" };
      return ap.api.cancelGoal(args.goalId);
    },
  },
};
