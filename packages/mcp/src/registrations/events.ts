// Event-bus tools — emit/query custom events.

import type { ToolDomain } from "../types";

const env = (k: string, fallback: string) => process.env[k] || fallback;

export const events: ToolDomain = {
  tools: [
    {
      name: "zana_event_emit",
      description: "Emit a custom event to the swarm event bus. Other agents and UI can observe it.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Event type (e.g. 'progress', 'milestone')" },
          payload: { type: "object", description: "Event data" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["type"],
      },
    },
    {
      name: "zana_event_query",
      description: "Query recent events from the swarm event bus.",
      inputSchema: {
        type: "object",
        properties: {
          types: { type: "array", items: { type: "string" }, description: "Filter by event types" },
          source: { type: "string", description: "Filter by source agent/daemon" },
          since: { type: "number", description: "Timestamp (ms) — only events after this" },
          limit: { type: "number", description: "Max events to return (default 50)" },
        },
      },
    },
  ],

  handlers: {
    zana_event_emit: (args, { callCore }) =>
      callCore("event_emit", {
        type: args.type,
        payload: args.payload,
        tags: args.tags,
        source: env("ZANA_TERMINAL_ID", "agent"),
      }),
    zana_event_query: (args, { callCore }) =>
      callCore("event_query", {
        types: args.types,
        source: args.source,
        since: args.since,
        limit: args.limit || 50,
      }),
  },
};
