// Workflow runs — trigger / list / get. Workflows are skill-based multi-step
// orchestrations executed by `@zana-ai/work`'s scheduling.workflowEngine.

import type { ToolDomain } from "../types";

// Lazy module loaders — keep the cross-package require-cycle safe.
function _workflowEngine(): any {
  return require("@zana-ai/work").scheduling.workflowEngine;
}
function _ticketService(): any {
  return require("@zana-ai/work").tickets.service;
}
function _skillStore(): any {
  return require("@zana-ai/extras").settings.skillStore;
}

export const workflows: ToolDomain = {
  tools: [
    {
      name: "zana_workflow_run",
      description:
        "Trigger a workflow skill by ID. Workflows orchestrate multi-step flows with conditional agent spawning, gates, and notifications.",
      inputSchema: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "ID of the workflow skill to run" },
          ticketId: { type: "string", description: "Optional ticket ID to pass as context" },
        },
        required: ["skillId"],
      },
    },
    {
      name: "zana_workflow_list_runs",
      description: "List workflow runs, optionally filtered by status.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["running", "completed", "halted", "failed"],
            description: "Filter by status",
          },
        },
      },
    },
    {
      name: "zana_workflow_get_run",
      description: "Get details of a specific workflow run.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string", description: "Workflow run ID" } },
        required: ["runId"],
      },
    },
  ],

  handlers: {
    zana_workflow_run: async (args) => {
      const skill = _skillStore().getSkill(args.skillId);
      if (!skill || skill.type !== "workflow") return { error: "workflow skill not found" };
      const context: any = {};
      if (args.ticketId) {
        context.ticket = _ticketService().getTicket(args.ticketId);
      }
      return await _workflowEngine().executeWorkflow(skill, context);
    },
    zana_workflow_list_runs: (args) => _workflowEngine().listRuns({ status: args.status }),
    zana_workflow_get_run: (args) => {
      const run = _workflowEngine().loadRun(args.runId);
      if (!run) return { error: "run not found" };
      return run;
    },
  },
};
