// Intelligence module — task router, vector memory, GOAP, background workers,
// per-module config. These hit `localDaemon.<module>` directly.

import type { ToolDomain } from "../types";

// Lazy module loader for module-config (cross-package require-cycle safety).
function _moduleConfig(): any {
  return require("@zana-ai/core").modules.config;
}

export const intelligence: ToolDomain = {
  tools: [
    {
      name: "zana_route_task",
      description: "Route a task to the best-fit agent profile based on content analysis",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The task description to route" },
          context: { type: "string", description: "Optional context about the task" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "zana_memory_store",
      description: "Store a memory/fact in the daemon vector memory for later retrieval",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The content to remember" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
          metadata: { type: "object", description: "Optional metadata" },
        },
        required: ["content"],
      },
    },
    {
      name: "zana_memory_search",
      description: "Search the daemon vector memory for relevant memories",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 5)" },
          tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
        },
        required: ["query"],
      },
    },
    {
      name: "zana_plan_create",
      description: "Create a goal-oriented action plan (GOAP) for a complex task",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The goal to achieve" },
          constraints: { type: "array", items: { type: "string" }, description: "Constraints to respect" },
          currentState: { type: "object", description: "Current world state" },
        },
        required: ["goal"],
      },
    },
    {
      name: "zana_workers_list",
      description: "List all background workers and their status",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "zana_module_config_list",
      description: "List all module configurations",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "zana_module_config_get",
      description: "Get configuration for a specific module",
      inputSchema: {
        type: "object",
        properties: { moduleId: { type: "string", description: "Module ID to get config for" } },
        required: ["moduleId"],
      },
    },
    {
      name: "zana_module_config_set",
      description: "Set a configuration value for a specific module",
      inputSchema: {
        type: "object",
        properties: {
          moduleId: { type: "string", description: "Module ID to configure" },
          key: { type: "string", description: "Configuration key" },
          value: { type: "string", description: "Configuration value" },
        },
        required: ["moduleId", "key", "value"],
      },
    },
  ],

  handlers: {
    zana_route_task: (args, { getDaemon }) => {
      const ticket = { title: args.prompt, description: args.context || "", labels: [] };
      return getDaemon().taskRouter.route(ticket);
    },
    zana_memory_store: (args, { getDaemon }) => {
      const metadata = { ...(args.metadata || {}), tags: args.tags || [] };
      return getDaemon().vectorMemory.store({ content: args.content, metadata });
    },
    zana_memory_search: (args, { getDaemon }) =>
      getDaemon().vectorMemory.search(args.query, { limit: args.limit || 5, tags: args.tags || [] }),
    zana_plan_create: (args, { getDaemon }) => {
      const options: any = {};
      if (args.constraints) options.constraints = args.constraints;
      if (args.currentState) options.initialState = args.currentState;
      return getDaemon().goapPlanner.createPlan(args.goal, options);
    },
    zana_workers_list: (_args, { getDaemon }) => getDaemon().backgroundWorkers.list(),
    zana_module_config_list: () => {
      const cfg = _moduleConfig().get();
      return cfg.modules || {};
    },
    zana_module_config_get: (args) => _moduleConfig().getModuleConfig(args.moduleId),
    zana_module_config_set: (args) => {
      const moduleConfig = _moduleConfig();
      const current = moduleConfig.getModuleConfig(args.moduleId);
      const config = { ...(current.config || {}), [args.key]: args.value };
      moduleConfig.setModuleConfig(args.moduleId, { ...current, config });
      return { ok: true, moduleId: args.moduleId, key: args.key, value: args.value };
    },
  },
};
