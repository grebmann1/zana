// Artifact CRUD — content-addressed planning documents shared across daemons.

import type { ToolDomain } from "../types";

const env = (k: string, fallback: string) => process.env[k] || fallback;

export const artifacts: ToolDomain = {
  tools: [
    {
      name: "zana_artifact_create",
      description:
        "Create a planning artifact (architecture doc, requirement spec, design doc, etc.) that is shared with all daemons. Use this to document plans, decisions, and specs before implementation.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title of the artifact" },
          type: {
            type: "string",
            enum: [
              "architecture-doc",
              "requirement-spec",
              "design-doc",
              "api-contract",
              "runbook",
              "decision-record",
              "custom",
            ],
            description: "Type of planning artifact",
          },
          content: { type: "string", description: "Full markdown content of the artifact" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for filtering" },
          linkedTickets: {
            type: "array",
            items: { type: "string" },
            description: "IDs of related tickets",
          },
        },
        required: ["title", "type", "content"],
      },
    },
    {
      name: "zana_artifact_list",
      description:
        "List all shared planning artifacts. Returns metadata (id, title, type, tags) without full content.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Filter by artifact type" },
          tag: { type: "string", description: "Filter by tag" },
        },
      },
    },
    {
      name: "zana_artifact_read",
      description:
        "Read the full content of a specific artifact by ID. Use this to access architecture docs, requirement specs, and other planning documents.",
      inputSchema: {
        type: "object",
        properties: { artifactId: { type: "string", description: "The artifact ID to read" } },
        required: ["artifactId"],
      },
    },
    {
      name: "zana_artifact_update",
      description: "Update an existing artifact's content or metadata.",
      inputSchema: {
        type: "object",
        properties: {
          artifactId: { type: "string", description: "ID of the artifact to update" },
          title: { type: "string", description: "New title (optional)" },
          content: { type: "string", description: "New content (optional)" },
          tags: { type: "array", items: { type: "string" }, description: "New tags (optional)" },
          linkedTickets: {
            type: "array",
            items: { type: "string" },
            description: "Updated linked ticket IDs (optional)",
          },
        },
        required: ["artifactId"],
      },
    },
  ],

  handlers: {
    zana_artifact_create: (args, { callCore }) =>
      callCore("artifact_create", {
        title: args.title,
        type: args.type,
        content: args.content,
        tags: args.tags,
        linkedTickets: args.linkedTickets,
        createdBy: env("ZANA_TERMINAL_ID", "agent"),
      }),
    zana_artifact_list: (args, { callCore }) =>
      callCore("artifact_list", { type: args.type, tag: args.tag }),
    zana_artifact_read: (args, { callCore }) =>
      callCore("artifact_read", { artifactId: args.artifactId }),
    zana_artifact_update: (args, { callCore }) =>
      callCore("artifact_update", {
        artifactId: args.artifactId,
        title: args.title,
        content: args.content,
        tags: args.tags,
        linkedTickets: args.linkedTickets,
      }),
  },
};
