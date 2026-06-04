// Sprint CRUD + lifecycle.

import type { ToolDomain } from "../types";

export const sprints: ToolDomain = {
  tools: [
    {
      name: "zana_sprint_list",
      description: "List sprints, optionally filtered by team or status.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string" },
          status: { type: "string", enum: ["planning", "active", "completed"] },
        },
      },
    },
    {
      name: "zana_sprint_board",
      description:
        "Get a sprint board with tickets grouped by status columns (backlog, in-progress, review, done). Returns a slim shape (id/title/status/priority/assigneeName/labels) by default; pass verbose=true for the full ticket payload (description + audit + comments).",
      inputSchema: {
        type: "object",
        properties: {
          sprintId: { type: "string", description: "Sprint ID" },
          verbose: { type: "boolean", description: "Return full ticket payloads (default: false — slim shape)" },
        },
        required: ["sprintId"],
      },
    },
    {
      name: "zana_sprint_create",
      description: "Create a new sprint to organize tickets.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Sprint name" },
          teamId: { type: "string", description: "Team this sprint belongs to" },
          ticketIds: { type: "array", items: { type: "string" }, description: "Tickets to include" },
        },
        required: ["name"],
      },
    },
    {
      name: "zana_sprint_start",
      description: "Start a sprint (moves from planning to active).",
      inputSchema: {
        type: "object",
        properties: { sprintId: { type: "string" } },
        required: ["sprintId"],
      },
    },
    {
      name: "zana_sprint_end",
      description: "End an active sprint.",
      inputSchema: {
        type: "object",
        properties: { sprintId: { type: "string" } },
        required: ["sprintId"],
      },
    },
  ],

  handlers: {
    zana_sprint_list: (args, { callCore }) => callCore("sprint_list", { teamId: args.teamId, status: args.status }),
    zana_sprint_board: async (args, { callCore }) => {
      const board: any = await callCore("sprint_board", { sprintId: args.sprintId });
      if (args.verbose) return board;
      const slim = (t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        assigneeName: t.assigneeName ?? null,
        labels: t.labels ?? [],
        closedAt: t.closedAt ?? null,
      });
      const out: Record<string, any> = {};
      for (const [col, tickets] of Object.entries(board || {})) {
        out[col] = Array.isArray(tickets) ? tickets.map(slim) : tickets;
      }
      return out;
    },
    zana_sprint_create: (args, { callCore }) =>
      callCore("sprint_create", { name: args.name, teamId: args.teamId, ticketIds: args.ticketIds }),
    zana_sprint_start: (args, { callCore }) => callCore("sprint_start", { sprintId: args.sprintId }),
    zana_sprint_end: (args, { callCore }) => callCore("sprint_end", { sprintId: args.sprintId }),
  },
};
