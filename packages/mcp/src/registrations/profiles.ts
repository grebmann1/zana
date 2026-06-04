// Profile CRUD — list / get / save / delete.

import type { ToolDomain } from "../types";

export const profiles: ToolDomain = {
  tools: [
    {
      name: "zana_list_profiles",
      description: "List all available agent profiles that can be spawned.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "zana_get_profile",
      description: "Get the full configuration of a specific profile.",
      inputSchema: {
        type: "object",
        properties: { profileId: { type: "string", description: "Profile ID to retrieve" } },
        required: ["profileId"],
      },
    },
    {
      name: "zana_save_profile",
      description:
        "Create or update an agent profile. Provide an id to update, omit for new. Fields: displayName, description, icon, category, model, systemPrompt, appendSystemPrompt, permissionMode, allowedTools, disallowedTools, maxBudgetUsd, effortLevel, defaultCwd.",
      inputSchema: {
        type: "object",
        properties: {
          profile: {
            type: "object",
            description: "Profile object. Include 'id' to update existing, omit for new.",
            properties: {
              id: { type: "string" },
              displayName: { type: "string" },
              description: { type: "string" },
              icon: { type: "string" },
              category: { type: "string" },
              model: { type: "string" },
              systemPrompt: { type: "string" },
              appendSystemPrompt: { type: "string" },
              permissionMode: { type: "string" },
              allowedTools: { type: "array", items: { type: "string" } },
              disallowedTools: { type: "array", items: { type: "string" } },
              maxBudgetUsd: { type: "number" },
              effortLevel: { type: "string" },
              defaultCwd: { type: "string" },
            },
          },
        },
        required: ["profile"],
      },
    },
    {
      name: "zana_delete_profile",
      description: "Delete a user-created profile by ID. Built-in profiles cannot be deleted.",
      inputSchema: {
        type: "object",
        properties: { profileId: { type: "string", description: "Profile ID to delete" } },
        required: ["profileId"],
      },
    },
  ],

  handlers: {
    zana_list_profiles: (_args, { callCore }) => callCore("list_profiles"),
    zana_get_profile: (args, { callCore }) => callCore("get_profile", { profileId: args.profileId }),
    zana_save_profile: (args, { callCore }) => callCore("save_profile", { profile: args.profile }),
    zana_delete_profile: (args, { callCore }) => callCore("delete_profile", { profileId: args.profileId }),
  },
};
