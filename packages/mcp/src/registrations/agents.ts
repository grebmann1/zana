// Agent lifecycle tools — spawn / list / status / result / kill / oneshot.
//
// All of these are gated by ZANA_DAEMON_TOOLS in the default install (see
// ../gating.ts). They are still registered here so the daemon path keeps
// working when ZANA_DAEMON_TOOLS=1; the gate filters them at tools/list and
// rejects them at tools/call.

import type { ToolDomain } from "../types";

export const agents: ToolDomain = {
  tools: [
    {
      name: "zana_spawn_agent",
      description:
        "Spawn a sub-agent from an available profile. The agent runs in headless mode and works on the current project.",
      inputSchema: {
        type: "object",
        properties: {
          profileId: { type: "string", description: "Profile ID to spawn (use zana_list_profiles to see available)" },
          prompt: { type: "string", description: "Initial task/prompt to give the sub-agent" },
        },
        required: ["profileId", "prompt"],
      },
    },
    {
      name: "zana_spawn_agent_validated",
      description:
        "Spawn a sub-agent with output validation guardrails. The agent's output is checked against the specified validators and retried automatically if validation fails.",
      inputSchema: {
        type: "object",
        properties: {
          profileId: { type: "string", description: "Profile ID to spawn" },
          prompt: { type: "string", description: "Initial task/prompt for the agent" },
          guardrails: {
            type: "array",
            description: "List of guardrail configs to validate the agent's output",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["json-parse", "json-schema", "no-secrets", "max-length", "file-exists", "contains-pattern"],
                  description: "Guardrail type",
                },
                maxChars: { type: "number", description: "For max-length: maximum character count" },
                path: { type: "string", description: "For file-exists: expected file path" },
                pattern: { type: "string", description: "For contains-pattern: regex pattern" },
                description: { type: "string", description: "For contains-pattern: human description of what pattern checks" },
              },
              required: ["type"],
            },
          },
          maxRetries: { type: "number", description: "Maximum retry attempts on validation failure (default: 2)" },
        },
        required: ["profileId", "prompt", "guardrails"],
      },
    },
    {
      name: "zana_oneshot_query",
      description:
        "Run a quick one-shot query using a profile. Returns the text response directly. Much cheaper than spawning a full agent session — use for lookups, summaries, quick questions.",
      inputSchema: {
        type: "object",
        properties: {
          profileId: { type: "string", description: "Profile ID to use" },
          prompt: { type: "string", description: "The question or task" },
          timeout: { type: "number", description: "Timeout in ms (default 60000)" },
        },
        required: ["profileId", "prompt"],
      },
    },
    {
      name: "zana_list_agents",
      description: "List all currently running agents with their status.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "zana_agent_status",
      description: "Get detailed status of a specific agent.",
      inputSchema: {
        type: "object",
        properties: { agentId: { type: "string", description: "Agent ID to check" } },
        required: ["agentId"],
      },
    },
    {
      name: "zana_agent_result",
      description: "Get the result/output of a completed agent. Returns null if agent is still running.",
      inputSchema: {
        type: "object",
        properties: { agentId: { type: "string", description: "Agent ID to get results from" } },
        required: ["agentId"],
      },
    },
    {
      name: "zana_kill_agent",
      description: "Kill/terminate a running agent.",
      inputSchema: {
        type: "object",
        properties: { agentId: { type: "string", description: "Agent ID to kill" } },
        required: ["agentId"],
      },
    },
  ],

  handlers: {
    zana_spawn_agent: (args, { callCore, callerAgentId }) =>
      callCore("spawn_agent", { profileId: args.profileId, prompt: args.prompt, parentAgentId: callerAgentId }),
    zana_spawn_agent_validated: (args, { callCore, callerAgentId }) =>
      callCore("spawn_agent_validated", {
        profileId: args.profileId,
        prompt: args.prompt,
        parentAgentId: callerAgentId,
        guardrails: args.guardrails || [],
        maxRetries: args.maxRetries,
      }),
    zana_oneshot_query: (args, { callCore }) =>
      callCore("spawn_oneshot", { profileId: args.profileId, prompt: args.prompt, timeout: args.timeout }),
    zana_list_agents: (_args, { callCore }) => callCore("list_agents"),
    zana_agent_status: (args, { callCore }) => callCore("agent_status", { agentId: args.agentId }),
    zana_agent_result: (args, { callCore }) => callCore("agent_result", { agentId: args.agentId }),
    zana_kill_agent: (args, { callCore }) => callCore("kill_agent", { agentId: args.agentId }),
  },
};
