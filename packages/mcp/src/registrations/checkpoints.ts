// Checkpoint save/list/get/resume — for resuming team runs after interruption.

import type { ToolDomain } from "../types";

export const checkpoints: ToolDomain = {
  tools: [
    {
      name: "zana_checkpoint_save",
      description:
        "Manually save a checkpoint of the current team run state. Includes completed and pending agents.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID this checkpoint belongs to" },
          pendingAgents: {
            type: "array",
            description: "Agents that still need to run",
            items: {
              type: "object",
              properties: {
                profileId: { type: "string" },
                prompt: { type: "string" },
                parentAgentId: { type: "string" },
                dependencies: {
                  type: "array",
                  items: { type: "string" },
                  description: "Agent IDs whose output is needed as context",
                },
              },
              required: ["profileId", "prompt"],
            },
          },
        },
        required: ["teamId"],
      },
    },
    {
      name: "zana_checkpoint_list",
      description: "List saved checkpoints, optionally filtered by teamId or status.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string" },
          status: { type: "string", enum: ["running", "completed", "stopped", "resumed"] },
        },
      },
    },
    {
      name: "zana_checkpoint_get",
      description: "Get full details of a specific checkpoint.",
      inputSchema: {
        type: "object",
        properties: { checkpointId: { type: "string", description: "Checkpoint ID" } },
        required: ["checkpointId"],
      },
    },
    {
      name: "zana_checkpoint_resume",
      description:
        "Resume a stopped or interrupted team run from a checkpoint. Re-spawns pending agents with context from completed ones.",
      inputSchema: {
        type: "object",
        properties: {
          checkpointId: { type: "string", description: "Checkpoint ID to resume from" },
        },
        required: ["checkpointId"],
      },
    },
  ],

  handlers: {
    zana_checkpoint_save: (args, { callCore }) =>
      callCore("checkpoint_save", {
        teamId: args.teamId,
        pendingAgents: args.pendingAgents || [],
        status: "running",
      }),
    zana_checkpoint_list: (args, { callCore }) =>
      callCore("checkpoint_list", { teamId: args.teamId, status: args.status }),
    zana_checkpoint_get: (args, { callCore }) =>
      callCore("checkpoint_get", { checkpointId: args.checkpointId }),
    zana_checkpoint_resume: (args, { callCore }) =>
      callCore("checkpoint_resume", { checkpointId: args.checkpointId }),
  },
};
