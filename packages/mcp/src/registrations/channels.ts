// P2P / channels — agent-to-agent messaging, named channels, inbox.

import type { ToolDomain } from "../types";

export const channels: ToolDomain = {
  tools: [
    {
      name: "zana_discover_agents",
      description:
        "Discover agents across the entire swarm. Returns agent IDs, names, profiles, and which daemon they belong to. Use this to find agents you can ask questions to.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional search filter (matches agent name, profile, ID)" },
        },
      },
    },
    {
      name: "zana_ask_agent",
      description:
        "Send a question to another agent (P2P). Questions are read-only — you cannot give instructions, only ask. The agent will see your question in their inbox on their next tool call.",
      inputSchema: {
        type: "object",
        properties: {
          toAgentId: { type: "string", description: "Target agent ID (from zana_discover_agents)" },
          question: { type: "string", description: "Your question for the other agent" },
          replyTo: { type: "string", description: "Optional message ID if this is a reply" },
        },
        required: ["toAgentId", "question"],
      },
    },
    {
      name: "zana_check_inbox",
      description:
        "Explicitly check your inbox for P2P messages from other agents. Messages are also auto-appended to tool responses, but use this to check proactively.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "zana_send_message",
      description: "Send a typed message to another agent. Provide either toAgentId (UUID) or toAgentName (e.g. 'synthesizer'); if both are given, toAgentId wins. Supports various message types for structured communication.",
      inputSchema: {
        type: "object",
        properties: {
          toAgentId: { type: "string", description: "Target agent ID (UUID). Either this or toAgentName is required." },
          toAgentName: { type: "string", description: "Target agent by human-readable name (resolved via active agent registry). Either this or toAgentId is required." },
          type: {
            type: "string",
            enum: ["question", "finding", "handoff", "status", "request"],
            description: "Message type",
          },
          payload: {
            type: "object",
            description: "Message payload",
            properties: {
              kind: {
                type: "string",
                enum: ["text", "structured", "file-ref", "handoff"],
                description: "Payload format",
              },
              content: { type: "string", description: "For text: message content" },
              data: { type: "object", description: "For structured: arbitrary JSON data" },
              paths: { type: "array", items: { type: "string" }, description: "For file-ref: file paths" },
              ticketId: { type: "string", description: "For handoff: ticket ID being handed off" },
            },
            required: ["kind"],
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "urgent"],
            description: "Message priority (default: normal)",
          },
          replyTo: { type: "string", description: "Message ID if this is a reply" },
          requiresAck: { type: "boolean", description: "Whether to request acknowledgment" },
        },
        required: ["type", "payload"],
      },
    },
    {
      name: "zana_publish_channel",
      description: "Publish a message to a named channel. All subscribed agents receive it in their inbox.",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel name (e.g. 'findings', 'blockers', 'progress')",
          },
          type: { type: "string", enum: ["finding", "status", "request"], description: "Message type" },
          payload: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["text", "structured", "file-ref"] },
              content: { type: "string" },
              data: { type: "object" },
              paths: { type: "array", items: { type: "string" } },
            },
            required: ["kind"],
          },
        },
        required: ["channel", "type", "payload"],
      },
    },
    {
      name: "zana_subscribe_channel",
      description: "Subscribe to a named channel to receive messages published to it.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name to subscribe to" },
        },
        required: ["channel"],
      },
    },
    {
      name: "zana_list_channels",
      description: "List all active channels with subscriber counts and last activity.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "zana_channel_history",
      description: "Get recent message history from a channel.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name" },
          limit: { type: "number", description: "Max messages to return (default: 50)" },
        },
        required: ["channel"],
      },
    },
    {
      name: "zana_send_ack",
      description: "Acknowledge receipt/processing of a message that requested acknowledgment.",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "ID of the message to acknowledge" },
          status: {
            type: "string",
            enum: ["received", "processing", "completed"],
            description: "Acknowledgment status",
          },
          response: { type: "string", description: "Optional response text" },
        },
        required: ["messageId", "status"],
      },
    },
  ],

  handlers: {
    zana_discover_agents: (args, { callCore }) => callCore("discover_agents", { query: args.query }),
    zana_ask_agent: (args, { callCore }) =>
      callCore("ask_agent", {
        toAgentId: args.toAgentId,
        question: args.question,
        replyTo: args.replyTo,
        fromTerminalId: process.env.ZANA_TERMINAL_ID,
        fromAgentName: process.env.ZANA_AGENT_NAME || "Agent",
      }),
    zana_check_inbox: (_args, { callCore }) =>
      callCore("check_inbox", { terminalId: process.env.ZANA_TERMINAL_ID }),
    zana_send_message: async (args, { callCore, callerAgentId }) => {
      let toAgentId: string | undefined = args.toAgentId;
      if (!toAgentId && args.toAgentName) {
        toAgentId = await callCore("resolve_agent_name", { name: args.toAgentName });
        if (!toAgentId) {
          return { ok: false, error: `no agent matching name "${args.toAgentName}"` };
        }
      }
      if (!toAgentId) {
        return { ok: false, error: "must provide toAgentId or toAgentName" };
      }
      return callCore("send_message", {
        toAgentId,
        type: args.type,
        payload: args.payload,
        priority: args.priority || "normal",
        replyTo: args.replyTo,
        requiresAck: args.requiresAck || false,
        fromAgentId: callerAgentId,
        fromAgentName: process.env.ZANA_AGENT_NAME || "Agent",
      });
    },
    zana_publish_channel: (args, { callCore, callerAgentId }) =>
      callCore("publish_channel", {
        channel: args.channel,
        type: args.type,
        payload: args.payload,
        fromAgentId: callerAgentId,
        fromAgentName: process.env.ZANA_AGENT_NAME || "Agent",
      }),
    zana_subscribe_channel: (args, { callCore, callerAgentId }) =>
      callCore("subscribe_channel", { channel: args.channel, agentId: callerAgentId }),
    zana_list_channels: (_args, { callCore }) => callCore("list_channels"),
    zana_channel_history: (args, { callCore }) =>
      callCore("channel_history", { channel: args.channel, limit: args.limit || 50 }),
    zana_send_ack: (args, { callCore, callerAgentId }) =>
      callCore("send_ack", {
        messageId: args.messageId,
        status: args.status,
        response: args.response,
        agentId: callerAgentId,
      }),
  },
};
