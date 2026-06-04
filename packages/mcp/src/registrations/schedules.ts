// Scheduler CRUD + lifecycle. Daemon-only — see CLAUDE.md "Scheduling".

import type { ToolDomain } from "../types";

const env = (k: string, fallback: string) => process.env[k] || fallback;

export const schedules: ToolDomain = {
  tools: [
    {
      name: "zana_schedule_create",
      description:
        "Create a scheduled recurring action. New schedules are persisted as YAML in <workspace>/.zana/scheduler/<id>.yml. Supports a 5-field cron expression OR an intervalMs OR an `every` shorthand (e.g. '5m', '1h', '2d'). Cron schedules fire via node-cron in the daemon and survive restarts.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for this schedule" },
          description: { type: "string" },
          cron: {
            type: "string",
            description: "5-field cron expression (min hour dom mon dow). Takes precedence over intervalMs/every.",
          },
          intervalMs: { type: "number", description: "Simple interval in milliseconds (alternative to cron)" },
          every: {
            type: "string",
            description: "Shorthand interval, e.g. '5m', '1h', '30s', '2d'. Resolved to intervalMs internally.",
          },
          action: {
            type: "object",
            description: "Action to execute when the schedule fires",
            properties: {
              type: { type: "string", enum: ["prompt", "spawn-agent", "team", "command", "workflow", "mcp_tool"] },
              profileId: { type: "string" },
              prompt: { type: "string" },
              teamId: { type: "string" },
              command: {
                type: "array",
                items: { type: "string" },
                description:
                  "argv array — first element is the binary, rest are args. Shell strings are rejected for safety. Example: [\"npm\", \"run\", \"build\"]",
              },
              cwd: { type: "string" },
              toolName: { type: "string" },
              toolArgs: { type: "object" },
            },
            required: ["type"],
          },
          enabled: { type: "boolean" },
        },
        required: ["name", "action"],
      },
    },
    {
      name: "zana_schedule_list",
      description: "List all scheduled actions.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "zana_schedule_get",
      description: "Get a schedule and its recent run history.",
      inputSchema: {
        type: "object",
        properties: { scheduleId: { type: "string" } },
        required: ["scheduleId"],
      },
    },
    {
      name: "zana_schedule_update",
      description: "Update a schedule's configuration.",
      inputSchema: {
        type: "object",
        properties: {
          scheduleId: { type: "string" },
          name: { type: "string" },
          cron: { type: "string" },
          intervalMs: { type: "number" },
          action: { type: "object" },
          enabled: { type: "boolean" },
        },
        required: ["scheduleId"],
      },
    },
    {
      name: "zana_schedule_delete",
      description: "Delete a schedule.",
      inputSchema: {
        type: "object",
        properties: { scheduleId: { type: "string" } },
        required: ["scheduleId"],
      },
    },
    {
      name: "zana_schedule_enable",
      description: "Enable a disabled schedule.",
      inputSchema: {
        type: "object",
        properties: { scheduleId: { type: "string" } },
        required: ["scheduleId"],
      },
    },
    {
      name: "zana_schedule_disable",
      description: "Disable a schedule without deleting it.",
      inputSchema: {
        type: "object",
        properties: { scheduleId: { type: "string" } },
        required: ["scheduleId"],
      },
    },
    {
      name: "zana_schedule_trigger",
      description: "Manually trigger a schedule to run immediately.",
      inputSchema: {
        type: "object",
        properties: { scheduleId: { type: "string" } },
        required: ["scheduleId"],
      },
    },
    {
      name: "zana_schedule_reload",
      description:
        "Re-read all <workspace>/.zana/scheduler/*.{yml,json} files from disk and re-register triggers for the enabled ones. Use after hand-editing schedule YAML files so the daemon picks up the changes without a restart. Idempotent.",
      inputSchema: { type: "object", properties: {} },
    },
  ],

  handlers: {
    zana_schedule_create: (args, { callCore }) =>
      callCore("schedule_create", {
        name: args.name,
        description: args.description,
        cron: args.cron,
        intervalMs: args.intervalMs,
        every: args.every,
        action: args.action,
        enabled: args.enabled,
        ownerId: env("ZANA_TERMINAL_ID", "agent"),
        ownerName: env("ZANA_AGENT_NAME", "Agent"),
      }),
    zana_schedule_list: (_args, { callCore }) => callCore("schedule_list"),
    zana_schedule_get: (args, { callCore }) => callCore("schedule_get", { scheduleId: args.scheduleId }),
    zana_schedule_update: (args, { callCore }) =>
      callCore("schedule_update", {
        id: args.scheduleId,
        name: args.name,
        cron: args.cron,
        intervalMs: args.intervalMs,
        action: args.action,
        enabled: args.enabled,
      }),
    zana_schedule_delete: (args, { callCore }) => callCore("schedule_delete", { id: args.scheduleId }),
    zana_schedule_enable: (args, { callCore }) => callCore("schedule_enable", { id: args.scheduleId }),
    zana_schedule_disable: (args, { callCore }) => callCore("schedule_disable", { id: args.scheduleId }),
    zana_schedule_trigger: (args, { callCore }) => callCore("schedule_trigger", { id: args.scheduleId }),
    zana_schedule_reload: (_args, { callCore }) => callCore("schedule_reload"),
  },
};
