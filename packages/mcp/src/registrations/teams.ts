// Team templates + running-team lifecycle.
//
// list/get/save/delete operate on team templates (path-agnostic). Lifecycle
// tools (start/stop/status/list-running) are gated by ZANA_DAEMON_TOOLS.

import type { ToolDomain } from "../types";

export const teams: ToolDomain = {
  tools: [
    {
      name: "zana_list_teams",
      description:
        "List all configured team templates (name, orchestrator profile, worker profiles, slot counts).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "zana_get_team",
      description: "Get full configuration of a specific team.",
      inputSchema: {
        type: "object",
        properties: { teamId: { type: "string", description: "Team ID" } },
        required: ["teamId"],
      },
    },
    {
      name: "zana_start_team",
      description: "Start a team — spawn the orchestrator + workers per the team's slot config. Returns the run ID.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID to start" },
          prompt: { type: "string", description: "Initial task/prompt for the orchestrator" },
          cwd: { type: "string", description: "Working directory (defaults to current workspace)" },
        },
        required: ["teamId", "prompt"],
      },
    },
    {
      name: "zana_stop_team",
      description: "Stop a running team — kills the orchestrator and all workers.",
      inputSchema: {
        type: "object",
        properties: { teamId: { type: "string", description: "Team ID to stop" } },
        required: ["teamId"],
      },
    },
    {
      name: "zana_team_status",
      description: "Get status of a running team — orchestrator state, worker states, run ID.",
      inputSchema: {
        type: "object",
        properties: { teamId: { type: "string", description: "Team ID" } },
        required: ["teamId"],
      },
    },
    {
      name: "zana_save_team",
      description:
        "Create or update a team template. Provide an id to update, omit for new. Fields: name, icon, description, orchestratorProfileId, slots ([{profileId, quantity}]), initialPrompt, rules, autoStart, dynamicSpawning, maxTotalWorkers.",
      inputSchema: {
        type: "object",
        properties: {
          team: {
            type: "object",
            description: "Team template object. Include 'id' to update existing, omit for new.",
            additionalProperties: false,
            properties: {
              id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$", maxLength: 128 },
              name: { type: "string", maxLength: 200 },
              icon: { type: "string", maxLength: 16 },
              description: { type: "string", maxLength: 1000 },
              orchestratorProfileId: { type: "string", maxLength: 128 },
              slots: {
                type: "array",
                maxItems: 32,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    profileId: { type: "string", maxLength: 128 },
                    quantity: { type: "number", minimum: 1, maximum: 10 },
                  },
                  required: ["profileId", "quantity"],
                },
              },
              initialPrompt: { type: "string", maxLength: 8000 },
              rules: {
                type: "object",
                additionalProperties: false,
                properties: {
                  maxConcurrentWorkers: { type: "number", minimum: 1, maximum: 32 },
                  autoRestart: { type: "boolean" },
                  requireApproval: { type: "boolean" },
                  orchestratorAllowedTools: {
                    type: "array",
                    items: { type: "string", maxLength: 128 },
                    maxItems: 64,
                  },
                },
              },
              autoStart: { type: "boolean" },
              dynamicSpawning: { type: "boolean" },
              maxTotalWorkers: { type: "number", minimum: 1, maximum: 64 },
            },
          },
        },
        required: ["team"],
      },
    },
    {
      name: "zana_delete_team",
      description:
        "Delete a team template by ID. Built-in templates re-seed on daemon restart unless their seed-marker tracks them as deleted.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: {
            type: "string",
            description: "Team ID to delete",
            pattern: "^[a-zA-Z0-9_-]+$",
            maxLength: 128,
          },
        },
        required: ["teamId"],
      },
    },
    {
      name: "zana_list_running_teams",
      description: "List all currently running teams with their statuses.",
      inputSchema: { type: "object", properties: {} },
    },
  ],

  handlers: {
    zana_list_teams: async (_args, { callCore }) => {
      const teams = await callCore("list_teams");
      if (!Array.isArray(teams)) return teams;
      // Drop unspawnable teams (no slots) — `/zana:team` can't start them, so
      // they have no purpose in the list. Catches both auto-saved editor
      // drafts and abandoned test artifacts.
      const usable = teams.filter((t: any) => Array.isArray(t.slots) && t.slots.length > 0);
      return usable.map((t: any) => ({
        id: t.id,
        name: t.name,
        icon: t.icon,
        description: t.description,
        orchestratorProfileId: t.orchestratorProfileId,
        slots: t.slots || [],
        slotCount: Array.isArray(t.slots)
          ? t.slots.reduce((n: number, s: any) => n + (s.quantity || 0), 0)
          : 0,
        autoStart: t.autoStart,
        updatedAt: t.updatedAt,
      }));
    },
    zana_get_team: (args, { callCore }) => callCore("get_team", { teamId: args.teamId }),
    zana_start_team: (args, { callCore }) =>
      callCore("start_team", { teamId: args.teamId, prompt: args.prompt, cwd: args.cwd }),
    zana_stop_team: (args, { callCore }) => callCore("stop_team", { teamId: args.teamId }),
    zana_team_status: async (args, { callCore }) => {
      const status: any = await callCore("team_status", { teamId: args.teamId });
      if (!status) return status;
      const projectAgent = (a: any) =>
        a && {
          id: a.id,
          profileId: a.profileId,
          profileName: a.profileName,
          profileIcon: a.profileIcon,
          state: a.state,
          model: a.model,
          pid: a.pid,
          mode: a.mode,
          lastAction: a.lastAction,
          lastActivity: a.lastActivity,
          tokenCount: a.tokenCount,
          spawnedAt: a.spawnedAt,
          parentAgentId: a.parentAgentId,
          terminalId: a.terminalId,
          result: a.result,
        };
      return {
        teamId: status.teamId,
        teamName: status.teamName,
        teamIcon: status.teamIcon,
        orchestratorAgentId: status.orchestratorAgentId,
        checkpointId: status.checkpointId,
        status: status.status,
        startedAt: status.startedAt,
        stoppedAt: status.stoppedAt,
        orchestrator: projectAgent(status.orchestrator),
        workers: Array.isArray(status.workers) ? status.workers.map(projectAgent) : [],
      };
    },
    zana_list_running_teams: (_args, { callCore }) => callCore("list_running_teams"),
    zana_save_team: (args, { callCore }) => callCore("save_team", { team: args.team }),
    zana_delete_team: (args, { callCore }) => callCore("delete_team", { teamId: args.teamId }),
  },
};
