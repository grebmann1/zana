// Skill CRUD — list / get / save / delete / toggle.

import type { ToolDomain } from "../types";

export const skills: ToolDomain = {
  tools: [
    {
      name: "zana_list_skills",
      description: "List all Skills (shared instructions and tools injected into all agents).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "zana_get_skill",
      description: "Get a specific Skill by ID.",
      inputSchema: {
        type: "object",
        properties: { skillId: { type: "string", description: "Skill ID to retrieve" } },
        required: ["skillId"],
      },
    },
    {
      name: "zana_save_skill",
      description:
        "Create or update a Skill. For instruction type: provide content (markdown text injected into agent system prompts). For tool type: provide toolSchema and handler.",
      inputSchema: {
        type: "object",
        properties: {
          skill: {
            type: "object",
            description: "Skill object. Include 'id' to update existing, omit for new.",
            properties: {
              id: { type: "string" },
              name: { type: "string", description: "Short identifier" },
              description: { type: "string" },
              type: { type: "string", enum: ["instruction", "tool"] },
              content: { type: "string", description: "Instruction text (for type=instruction)" },
              toolSchema: { type: "object", description: "MCP tool schema (for type=tool)" },
              handler: { type: "string", description: "Built-in handler name: scratchpad, broadcast (for type=tool)" },
              enabled: { type: "boolean" },
            },
            required: ["name", "type"],
          },
        },
        required: ["skill"],
      },
    },
    {
      name: "zana_delete_skill",
      description: "Delete a Skill by ID.",
      inputSchema: {
        type: "object",
        properties: { skillId: { type: "string", description: "Skill ID to delete" } },
        required: ["skillId"],
      },
    },
    {
      name: "zana_toggle_skill",
      description: "Enable or disable a Skill without deleting it.",
      inputSchema: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill ID" },
          enabled: { type: "boolean", description: "Whether the skill should be enabled" },
        },
        required: ["skillId", "enabled"],
      },
    },
  ],

  handlers: {
    zana_list_skills: (_args, { callCore }) => callCore("list_skills"),
    zana_get_skill: (args, { callCore }) => callCore("get_skill", { skillId: args.skillId }),
    zana_save_skill: (args, { callCore }) => callCore("save_skill", { skill: args.skill }),
    zana_delete_skill: (args, { callCore }) => callCore("delete_skill", { skillId: args.skillId }),
    zana_toggle_skill: (args, { callCore }) =>
      callCore("toggle_skill", { skillId: args.skillId, enabled: args.enabled }),
  },
};
