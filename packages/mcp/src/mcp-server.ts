#!/usr/bin/env node
export {};

// Orchestrator MCP Server (stdio, JSON-RPC 2.0)
// Boots core in-process — no external daemon required.
// Inspired by ruflo: the MCP server IS the runtime.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { config: { SCRATCHPAD_DIR, SKILLS_DIR } } = require("@zana/core");

// MCP stdio protocol uses stdout for framed JSON-RPC only.
// Route normal logs to stderr to avoid corrupting the MCP stream.
const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  try {
    process.stderr.write(args.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ") + "\n");
  } catch {
    originalConsoleLog(...args);
  }
};

const MCP_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB stdin buffer cap

const ZANA_MASTER_MODE = process.env.ZANA_MASTER_MODE === "true";
const ZANA_ID = process.env.ZANA_ID || "mcp";
const SCRATCHPAD_PATH = path.join(SCRATCHPAD_DIR, `${ZANA_ID}.md`);

// --- In-process core (always boots — no daemon needed) ---
let localHive = null;
let bootstrapPromise = null;

function getHiveInitModule() {
  try {
    return require("@zana/core/dist/src/hive-init.js");
  } catch {
    const appRoot = path.resolve(__dirname, "..", "..", "..", "..");
    return require(path.join(appRoot, "packages", "core", "dist", "src", "hive-init.js"));
  }
}

async function ensureHiveRunning() {
  if (localHive) return;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const workspace = process.env.ZANA_WORKSPACE || require("path").resolve(__dirname, "..", "..", "..", "..");
    process.stderr.write(`[hive-mcp] booting core in-process for: ${workspace}\n`);

    const autoInitDisabled = process.env.ZANA_AUTO_INIT === "0";
    if (!autoInitDisabled) {
      const { isHiveInitialized, initHiveDir } = getHiveInitModule();
      if (!isHiveInitialized(workspace)) {
        initHiveDir(workspace, { silent: true });
        process.stderr.write(`[hive-mcp] initialized .zana in workspace: ${workspace}\n`);
      }
    }

    process.env.ZANA_SKIP_MCP_INSTALL = "1";
    const { init: coreInit } = require("@zana/core");
    localHive = await coreInit({
      workspace,
      headless: true,
      preferredPort: 0,
      skipApiServer: true,
      onHook: () => {},
    });

    process.stderr.write(`[hive-mcp] ready — id: ${localHive.hiveId} port: ${localHive.hookServerHandle?.port || "none"}\n`);
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });

  return bootstrapPromise;
}

function callCore(action, params = {}) {
  return localHive.agentManager.handleOrchestratorCommand(
    { action, ...params },
    () => localHive.workspace
  );
}

const TOOLS = [
  {
    name: "hive_spawn_agent",
    description: "Spawn a sub-agent from an available profile. The agent runs in headless mode and works on the current project.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "Profile ID to spawn (use hive_list_profiles to see available)" },
        prompt: { type: "string", description: "Initial task/prompt to give the sub-agent" },
      },
      required: ["profileId", "prompt"],
    },
  },
  {
    name: "hive_spawn_agent_validated",
    description: "Spawn a sub-agent with output validation guardrails. The agent's output is checked against the specified validators and retried automatically if validation fails.",
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
              type: { type: "string", enum: ["json-parse", "json-schema", "no-secrets", "max-length", "file-exists", "contains-pattern"], description: "Guardrail type" },
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
    name: "hive_oneshot_query",
    description: "Run a quick one-shot query using a profile. Returns the text response directly. Much cheaper than spawning a full agent session — use for lookups, summaries, quick questions.",
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
    name: "hive_list_agents",
    description: "List all currently running agents with their status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_agent_status",
    description: "Get detailed status of a specific agent.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID to check" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "hive_agent_result",
    description: "Get the result/output of a completed agent. Returns null if agent is still running.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID to get results from" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "hive_kill_agent",
    description: "Kill/terminate a running agent.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID to kill" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "hive_list_profiles",
    description: "List all available agent profiles that can be spawned.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_get_profile",
    description: "Get the full configuration of a specific profile.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "Profile ID to retrieve" },
      },
      required: ["profileId"],
    },
  },
  {
    name: "hive_save_profile",
    description: "Create or update an agent profile. Provide an id to update, omit for new. Fields: displayName, description, icon, category, model, systemPrompt, appendSystemPrompt, permissionMode, allowedTools, disallowedTools, maxBudgetUsd, effortLevel, defaultCwd.",
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
    name: "hive_delete_profile",
    description: "Delete a user-created profile by ID. Built-in profiles cannot be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "Profile ID to delete" },
      },
      required: ["profileId"],
    },
  },
  {
    name: "hive_list_skills",
    description: "List all Hive Skills (shared instructions and tools injected into all agents).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_get_skill",
    description: "Get a specific Hive Skill by ID.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID to retrieve" },
      },
      required: ["skillId"],
    },
  },
  {
    name: "hive_save_skill",
    description: "Create or update a Hive Skill. For instruction type: provide content (markdown text injected into agent system prompts). For tool type: provide toolSchema and handler.",
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
    name: "hive_delete_skill",
    description: "Delete a Hive Skill by ID.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID to delete" },
      },
      required: ["skillId"],
    },
  },
  {
    name: "hive_toggle_skill",
    description: "Enable or disable a Hive Skill without deleting it.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID" },
        enabled: { type: "boolean", description: "Whether the skill should be enabled" },
      },
      required: ["skillId", "enabled"],
    },
  },
];

// --- Ticket tools ---
const TICKET_TOOLS = [
  {
    name: "hive_ticket_create",
    description: "Create a new ticket for tracking work. Tickets are globally shared across all hives.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the ticket" },
        description: { type: "string", description: "Detailed description of the work" },
        priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Priority level" },
        labels: { type: "array", items: { type: "string" }, description: "Tags/labels" },
        blockedBy: { type: "array", items: { type: "string" }, description: "IDs of tickets blocking this one" },
        sprintId: { type: "string", description: "Sprint to add this ticket to" },
      },
      required: ["title"],
    },
  },
  {
    name: "hive_ticket_list",
    description: "List/filter tickets. All tickets are globally shared.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["backlog", "in-progress", "review", "done", "cancelled"] },
        sprintId: { type: "string" },
        assigneeId: { type: "string" },
        label: { type: "string" },
      },
    },
  },
  {
    name: "hive_ticket_get",
    description: "Get full details of a specific ticket including comments and history.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "Ticket ID" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "hive_ticket_claim",
    description: "Claim a ticket (assigns it to you and moves to in-progress). Works on backlog and rework tickets.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "Ticket ID to claim" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "hive_ticket_update_status",
    description: "Move a ticket to a new status. Valid transitions: backlog→in-progress/cancelled, in-progress→review/done/backlog/cancelled, review→done/rework/cancelled, rework→in-progress/cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        status: { type: "string", enum: ["backlog", "in-progress", "review", "rework", "blocked", "done", "cancelled"] },
      },
      required: ["ticketId", "status"],
    },
  },
  {
    name: "hive_ticket_comment",
    description: "Add a comment/update log to a ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        body: { type: "string", description: "Comment text" },
      },
      required: ["ticketId", "body"],
    },
  },
  {
    name: "hive_ticket_complete",
    description: "Mark a ticket as done with a result summary describing what was accomplished.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        resultSummary: { type: "string", description: "Summary of what was done" },
      },
      required: ["ticketId", "resultSummary"],
    },
  },
  {
    name: "hive_ticket_edit",
    description: "Edit a ticket's fields (title, description, priority, labels, type, sprintId). Only specified fields are updated.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "Ticket ID to edit" },
        title: { type: "string", description: "New title (optional)" },
        description: { type: "string", description: "New description (optional)" },
        priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "New priority (optional)" },
        labels: { type: "array", items: { type: "string" }, description: "New labels array (replaces existing)" },
        type: { type: "string", enum: ["bug", "feature", "chore", "spike"], description: "Ticket type (optional)" },
        sprintId: { type: "string", description: "Move to sprint (optional)" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "hive_ticket_update",
    description: "Update a ticket with progress, plan, status, review phase, or files changed. Workers and reviewers use this to report progress and advance the review pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "Ticket ID to update" },
        status: { type: "string", enum: ["in-progress", "review", "rework", "blocked", "done"], description: "Transition to new status" },
        reviewPhase: { type: "string", enum: ["qa", "architecture"], description: "Advance the review phase (QA reviewer sets 'architecture' on pass)" },
        progress: { type: "string", description: "Progress note or review feedback" },
        planification: { type: "string", description: "Implementation plan (written before coding)" },
        resultSummary: { type: "string", description: "Final result summary" },
        filesChanged: { type: "array", items: { type: "string" }, description: "File paths modified/created" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "hive_ticket_add_to_sprint",
    description: "Add a ticket to a sprint.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        sprintId: { type: "string" },
      },
      required: ["ticketId", "sprintId"],
    },
  },
  {
    name: "hive_sprint_list",
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
    name: "hive_sprint_board",
    description: "Get a sprint board with tickets grouped by status columns (backlog, in-progress, review, done).",
    inputSchema: {
      type: "object",
      properties: {
        sprintId: { type: "string", description: "Sprint ID" },
      },
      required: ["sprintId"],
    },
  },
  {
    name: "hive_sprint_create",
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
    name: "hive_sprint_start",
    description: "Start a sprint (moves from planning to active).",
    inputSchema: {
      type: "object",
      properties: {
        sprintId: { type: "string" },
      },
      required: ["sprintId"],
    },
  },
  {
    name: "hive_sprint_end",
    description: "End an active sprint.",
    inputSchema: {
      type: "object",
      properties: {
        sprintId: { type: "string" },
      },
      required: ["sprintId"],
    },
  },
];

// --- Scheduler tools ---
const SCHEDULER_TOOLS = [
  {
    name: "hive_schedule_create",
    description: "Create a scheduled recurring action. Supports cron expressions or simple intervals.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for this schedule" },
        description: { type: "string" },
        cron: { type: "string", description: "5-field cron expression (min hour dom mon dow)" },
        intervalMs: { type: "number", description: "Simple interval in milliseconds (alternative to cron)" },
        action: {
          type: "object",
          description: "Action to execute",
          properties: {
            type: { type: "string", enum: ["prompt", "team", "command", "mcp_tool"] },
            profileId: { type: "string" },
            prompt: { type: "string" },
            teamId: { type: "string" },
            command: { type: "string" },
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
    name: "hive_schedule_list",
    description: "List all scheduled actions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_schedule_get",
    description: "Get a schedule and its recent run history.",
    inputSchema: {
      type: "object",
      properties: {
        scheduleId: { type: "string" },
      },
      required: ["scheduleId"],
    },
  },
  {
    name: "hive_schedule_update",
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
    name: "hive_schedule_delete",
    description: "Delete a schedule.",
    inputSchema: {
      type: "object",
      properties: {
        scheduleId: { type: "string" },
      },
      required: ["scheduleId"],
    },
  },
  {
    name: "hive_schedule_enable",
    description: "Enable a disabled schedule.",
    inputSchema: {
      type: "object",
      properties: { scheduleId: { type: "string" } },
      required: ["scheduleId"],
    },
  },
  {
    name: "hive_schedule_disable",
    description: "Disable a schedule without deleting it.",
    inputSchema: {
      type: "object",
      properties: { scheduleId: { type: "string" } },
      required: ["scheduleId"],
    },
  },
  {
    name: "hive_schedule_trigger",
    description: "Manually trigger a schedule to run immediately.",
    inputSchema: {
      type: "object",
      properties: { scheduleId: { type: "string" } },
      required: ["scheduleId"],
    },
  },
];

// --- Event Bus tools ---
const EVENT_BUS_TOOLS = [
  {
    name: "hive_event_emit",
    description: "Emit a custom event to the hive event bus. Other agents and UI can observe it.",
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
    name: "hive_event_query",
    description: "Query recent events from the hive event bus.",
    inputSchema: {
      type: "object",
      properties: {
        types: { type: "array", items: { type: "string" }, description: "Filter by event types" },
        source: { type: "string", description: "Filter by source agent/hive" },
        since: { type: "number", description: "Timestamp (ms) — only events after this" },
        limit: { type: "number", description: "Max events to return (default 50)" },
      },
    },
  },
];

// --- P2P tools (available to ALL agents) ---
const P2P_TOOLS = [
  {
    name: "hive_discover_agents",
    description: "Discover agents across the entire Hive Mind. Returns agent IDs, names, profiles, and which hive they belong to. Use this to find agents you can ask questions to.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search filter (matches agent name, profile, ID)" },
      },
    },
  },
  {
    name: "hive_ask_agent",
    description: "Send a question to another agent (P2P). Questions are read-only — you cannot give instructions, only ask. The agent will see your question in their inbox on their next tool call.",
    inputSchema: {
      type: "object",
      properties: {
        toAgentId: { type: "string", description: "Target agent ID (from hive_discover_agents)" },
        question: { type: "string", description: "Your question for the other agent" },
        replyTo: { type: "string", description: "Optional message ID if this is a reply" },
      },
      required: ["toAgentId", "question"],
    },
  },
  {
    name: "hive_check_inbox",
    description: "Explicitly check your inbox for P2P messages from other agents. Messages are also auto-appended to tool responses, but use this to check proactively.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_send_message",
    description: "Send a typed message to another agent. Supports various message types for structured communication.",
    inputSchema: {
      type: "object",
      properties: {
        toAgentId: { type: "string", description: "Target agent ID" },
        type: { type: "string", enum: ["question", "finding", "handoff", "status", "request"], description: "Message type" },
        payload: {
          type: "object",
          description: "Message payload",
          properties: {
            kind: { type: "string", enum: ["text", "structured", "file-ref", "handoff"], description: "Payload format" },
            content: { type: "string", description: "For text: message content" },
            data: { type: "object", description: "For structured: arbitrary JSON data" },
            paths: { type: "array", items: { type: "string" }, description: "For file-ref: file paths" },
            ticketId: { type: "string", description: "For handoff: ticket ID being handed off" },
          },
          required: ["kind"],
        },
        priority: { type: "string", enum: ["low", "normal", "urgent"], description: "Message priority (default: normal)" },
        replyTo: { type: "string", description: "Message ID if this is a reply" },
        requiresAck: { type: "boolean", description: "Whether to request acknowledgment" },
      },
      required: ["toAgentId", "type", "payload"],
    },
  },
  {
    name: "hive_publish_channel",
    description: "Publish a message to a named channel. All subscribed agents receive it in their inbox.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name (e.g. 'findings', 'blockers', 'progress')" },
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
    name: "hive_subscribe_channel",
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
    name: "hive_list_channels",
    description: "List all active channels with subscriber counts and last activity.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_channel_history",
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
    name: "hive_send_ack",
    description: "Acknowledge receipt/processing of a message that requested acknowledgment.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "ID of the message to acknowledge" },
        status: { type: "string", enum: ["received", "processing", "completed"], description: "Acknowledgment status" },
        response: { type: "string", description: "Optional response text" },
      },
      required: ["messageId", "status"],
    },
  },
];

// --- Intelligence tools (task router, vector memory, GOAP, background workers) ---
const INTELLIGENCE_TOOLS = [
  {
    name: "hive_route_task",
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
    name: "hive_memory_store",
    description: "Store a memory/fact in the hive's vector memory for later retrieval",
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
    name: "hive_memory_search",
    description: "Search the hive's vector memory for relevant memories",
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
    name: "hive_plan_create",
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
    name: "hive_workers_list",
    description: "List all background workers and their status",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_module_config_list",
    description: "List all module configurations",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_module_config_get",
    description: "Get configuration for a specific module",
    inputSchema: {
      type: "object",
      properties: {
        moduleId: { type: "string", description: "Module ID to get config for" },
      },
      required: ["moduleId"],
    },
  },
  {
    name: "hive_module_config_set",
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
];

// --- Checkpoint tools ---
const CHECKPOINT_TOOLS = [
  {
    name: "hive_checkpoint_save",
    description: "Manually save a checkpoint of the current team run state. Includes completed and pending agents.",
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team ID this checkpoint belongs to" },
        pendingAgents: {
          type: "array",
          description: "Agents that still need to run",
          items: {
            type: "object",
            properties: {
              profileId: { type: "string" },
              prompt: { type: "string" },
              parentAgentId: { type: "string" },
              dependencies: { type: "array", items: { type: "string" }, description: "Agent IDs whose output is needed as context" },
            },
            required: ["profileId", "prompt"],
          },
        },
      },
      required: ["teamId"],
    },
  },
  {
    name: "hive_checkpoint_list",
    description: "List saved checkpoints, optionally filtered by teamId or status.",
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string" },
        status: { type: "string", enum: ["running", "completed", "stopped", "resumed"] },
      },
    },
  },
  {
    name: "hive_checkpoint_get",
    description: "Get full details of a specific checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        checkpointId: { type: "string", description: "Checkpoint ID" },
      },
      required: ["checkpointId"],
    },
  },
  {
    name: "hive_checkpoint_resume",
    description: "Resume a stopped or interrupted team run from a checkpoint. Re-spawns pending agents with context from completed ones.",
    inputSchema: {
      type: "object",
      properties: {
        checkpointId: { type: "string", description: "Checkpoint ID to resume from" },
      },
      required: ["checkpointId"],
    },
  },
];

// --- Workflow tools ---
const WORKFLOW_TOOLS = [
  {
    name: "hive_workflow_run",
    description: "Trigger a workflow skill by ID. Workflows orchestrate multi-step flows with conditional agent spawning, gates, and notifications.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "ID of the workflow skill to run" },
        ticketId: { type: "string", description: "Optional ticket ID to pass as context" },
      },
      required: ["skillId"],
    },
  },
  {
    name: "hive_workflow_list_runs",
    description: "List workflow runs, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["running", "completed", "halted", "failed"], description: "Filter by status" },
      },
    },
  },
  {
    name: "hive_workflow_get_run",
    description: "Get details of a specific workflow run.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Workflow run ID" },
      },
      required: ["runId"],
    },
  },
];

// --- Artifact tools (shared planning documents, available to ALL agents) ---
const ARTIFACT_TOOLS = [
  {
    name: "hive_artifact_create",
    description: "Create a planning artifact (architecture doc, requirement spec, design doc, etc.) that is shared with all hives. Use this to document plans, decisions, and specs before implementation.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the artifact" },
        type: { type: "string", enum: ["architecture-doc", "requirement-spec", "design-doc", "api-contract", "runbook", "decision-record", "custom"], description: "Type of planning artifact" },
        content: { type: "string", description: "Full markdown content of the artifact" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for filtering" },
        linkedTickets: { type: "array", items: { type: "string" }, description: "IDs of related tickets" },
      },
      required: ["title", "type", "content"],
    },
  },
  {
    name: "hive_artifact_list",
    description: "List all shared planning artifacts. Returns metadata (id, title, type, tags) without full content.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Filter by artifact type" },
        tag: { type: "string", description: "Filter by tag" },
      },
    },
  },
  {
    name: "hive_artifact_read",
    description: "Read the full content of a specific artifact by ID. Use this to access architecture docs, requirement specs, and other planning documents.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "The artifact ID to read" },
      },
      required: ["artifactId"],
    },
  },
  {
    name: "hive_artifact_update",
    description: "Update an existing artifact's content or metadata.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "ID of the artifact to update" },
        title: { type: "string", description: "New title (optional)" },
        content: { type: "string", description: "New content (optional)" },
        tags: { type: "array", items: { type: "string" }, description: "New tags (optional)" },
        linkedTickets: { type: "array", items: { type: "string" }, description: "Updated linked ticket IDs (optional)" },
      },
      required: ["artifactId"],
    },
  },
];

// --- Master-only tools (spawn/control sub-hives) ---
const MASTER_TOOLS = ZANA_MASTER_MODE ? [
  {
    name: "hive_mind_spawn_hive",
    description: "Spawn a new sub-hive (headless team). The sub-hive runs as a child process and can be controlled via instructions.",
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team ID to start in the sub-hive (optional — omit to spawn a single orchestrator)" },
        workspace: { type: "string", description: "Working directory for the sub-hive (defaults to current workspace)" },
        prompt: { type: "string", description: "Initial prompt/task for the sub-hive" },
      },
    },
  },
  {
    name: "hive_mind_list_hives",
    description: "List all spawned sub-hives with their status, ports, and team info.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_mind_instruct_hive",
    description: "Send an instruction to a sub-hive's team lead. Instructions flow DOWN only (master → team lead → workers).",
    inputSchema: {
      type: "object",
      properties: {
        hiveId: { type: "string", description: "Sub-hive ID to instruct" },
        message: { type: "string", description: "Instruction message for the team lead" },
      },
      required: ["hiveId", "message"],
    },
  },
  {
    name: "hive_mind_stop_hive",
    description: "Stop a sub-hive. Sends SIGTERM to the child process.",
    inputSchema: {
      type: "object",
      properties: {
        hiveId: { type: "string", description: "Sub-hive ID to stop" },
      },
      required: ["hiveId"],
    },
  },
  {
    name: "hive_mind_broadcast",
    description: "Send a message to ALL running sub-hives. Each team lead receives the instruction.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to broadcast to all sub-hive team leads" },
      },
      required: ["message"],
    },
  },
  {
    name: "hive_mind_poll_events",
    description: "Poll events from sub-hives (progress reports, decision requests, completions, errors).",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Timestamp (ms) — only return events after this time. Omit for all." },
      },
    },
  },
] : [];

// Load dynamic hive tool skills
function loadHiveToolSkills() {
  const skillsDir = SKILLS_DIR;
  try {
    const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".json"));
    const tools = [];
    for (const f of files) {
      try {
        const skill = JSON.parse(fs.readFileSync(path.join(skillsDir, f), "utf8"));
        if (skill.type === "tool" && skill.enabled && skill.toolSchema) {
          tools.push({ skill, schema: skill.toolSchema });
        }
      } catch (err) {
        process.stderr.write(`[orchestrator-mcp] failed to load skill ${f}: ${err.message}\n`);
      }
    }
    return tools;
  } catch (err) {
    if (err.code !== "ENOENT") {
      process.stderr.write(`[orchestrator-mcp] failed to read skills dir: ${err.message}\n`);
    }
    return [];
  }
}

const hiveToolSkills = loadHiveToolSkills();
const DYNAMIC_TOOLS = hiveToolSkills.map((t) => t.schema);
const STATIC_TOOLS = [...TOOLS, ...TICKET_TOOLS, ...INTELLIGENCE_TOOLS, ...CHECKPOINT_TOOLS, ...WORKFLOW_TOOLS, ...ARTIFACT_TOOLS, ...SCHEDULER_TOOLS, ...EVENT_BUS_TOOLS, ...P2P_TOOLS, ...MASTER_TOOLS, ...DYNAMIC_TOOLS];

// Module tool registry (tools contributed by modules via api.mcp in module.json)
let moduleToolRegistry = null;
function getModuleToolRegistry() {
  if (!moduleToolRegistry) {
    try {
      moduleToolRegistry = require("@zana/core").moduleToolRegistry;
    } catch {
      try {
        moduleToolRegistry = require(path.resolve(__dirname, "../../../core/dist/src/module-tool-registry.js"));
      } catch {
        moduleToolRegistry = { listModuleTools: () => [], getModuleTool: () => null };
      }
    }
  }
  return moduleToolRegistry;
}

function getAllTools() {
  const reg = getModuleToolRegistry();
  const moduleTools = reg.listModuleTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: "object", properties: {} },
  }));
  return [...STATIC_TOOLS, ...moduleTools];
}

// Built-in tool handlers
function handleScratchpad(args) {
  fs.mkdirSync(SCRATCHPAD_DIR, { recursive: true });
  switch (args.action) {
    case "read":
      try {
        return { content: fs.readFileSync(SCRATCHPAD_PATH, "utf8") };
      } catch {
        return { content: "" };
      }
    case "write":
      fs.writeFileSync(SCRATCHPAD_PATH, args.content || "", "utf8");
      return { ok: true };
    case "append":
      fs.appendFileSync(SCRATCHPAD_PATH, (args.content || "") + "\n", "utf8");
      return { ok: true };
    default:
      return { error: "unknown action, use: read, write, append" };
  }
}

function handleBroadcast(args) {
  if (localHive && localHive.hivemindRouter) {
    localHive.hivemindRouter.broadcast(args.message || "");
    return { ok: true };
  }
  return { ok: false, error: "hivemind not available" };
}

function sendResponse(id, result) {
  const msg = { jsonrpc: "2.0", id, result };
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendError(id, code, message) {
  const msg = { jsonrpc: "2.0", id, error: { code, message } };
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendNotification(method, params) {
  const msg = { jsonrpc: "2.0", method, params };
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function drainLocalInbox() {
  const agentId = process.env.ZANA_TERMINAL_ID;
  if (!agentId || !localHive?.hivemindRouter) return [];
  try {
    return localHive.hivemindRouter.drainInbox(agentId) || [];
  } catch {
    return [];
  }
}

async function handleToolCall(name, args, callerAgentId) {
  await ensureHiveRunning();

  switch (name) {
    case "hive_spawn_agent":
      return await callCore("spawn_agent", { profileId: args.profileId, prompt: args.prompt, parentAgentId: callerAgentId });
    case "hive_spawn_agent_validated":
      return await callCore("spawn_agent_validated", { profileId: args.profileId, prompt: args.prompt, parentAgentId: callerAgentId, guardrails: args.guardrails || [], maxRetries: args.maxRetries });
    case "hive_oneshot_query":
      return await callCore("spawn_oneshot", { profileId: args.profileId, prompt: args.prompt, timeout: args.timeout });
    case "hive_list_agents":
      return await callCore("list_agents");
    case "hive_agent_status":
      return await callCore("agent_status", { agentId: args.agentId });
    case "hive_agent_result":
      return await callCore("agent_result", { agentId: args.agentId });
    case "hive_kill_agent":
      return await callCore("kill_agent", { agentId: args.agentId });
    case "hive_list_profiles":
      return await callCore("list_profiles");
    case "hive_get_profile":
      return await callCore("get_profile", { profileId: args.profileId });
    case "hive_save_profile":
      return await callCore("save_profile", { profile: args.profile });
    case "hive_delete_profile":
      return await callCore("delete_profile", { profileId: args.profileId });
    case "hive_list_skills":
      return await callCore("list_skills");
    case "hive_get_skill":
      return await callCore("get_skill", { skillId: args.skillId });
    case "hive_save_skill":
      return await callCore("save_skill", { skill: args.skill });
    case "hive_delete_skill":
      return await callCore("delete_skill", { skillId: args.skillId });
    case "hive_toggle_skill":
      return await callCore("toggle_skill", { skillId: args.skillId, enabled: args.enabled });

    // Intelligence tools (direct module access)
    case "hive_route_task": {
      const ticket = { title: args.prompt, description: args.context || "", labels: [] };
      return localHive.taskRouter.route(ticket);
    }
    case "hive_memory_store": {
      const metadata = { ...(args.metadata || {}), tags: args.tags || [] };
      return localHive.vectorMemory.store({ content: args.content, metadata });
    }
    case "hive_memory_search": {
      return localHive.vectorMemory.search(args.query, { limit: args.limit || 5, tags: args.tags || [] });
    }
    case "hive_plan_create": {
      const options: any = {};
      if (args.constraints) options.constraints = args.constraints;
      if (args.currentState) options.initialState = args.currentState;
      return localHive.goapPlanner.createPlan(args.goal, options);
    }
    case "hive_workers_list": {
      return localHive.backgroundWorkers.list();
    }
    case "hive_module_config_list": {
      const moduleConfig = require("@zana/core").moduleConfig;
      const cfg = moduleConfig.get();
      return cfg.modules || {};
    }
    case "hive_module_config_get": {
      const moduleConfig = require("@zana/core").moduleConfig;
      return moduleConfig.getModuleConfig(args.moduleId);
    }
    case "hive_module_config_set": {
      const moduleConfig = require("@zana/core").moduleConfig;
      const current = moduleConfig.getModuleConfig(args.moduleId);
      const config = { ...(current.config || {}), [args.key]: args.value };
      moduleConfig.setModuleConfig(args.moduleId, { ...current, config });
      return { ok: true, moduleId: args.moduleId, key: args.key, value: args.value };
    }

    // Ticket tools
    case "hive_ticket_create":
      return await callCore("ticket_create", { title: args.title, description: args.description, priority: args.priority, labels: args.labels, blockedBy: args.blockedBy, sprintId: args.sprintId, createdBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "hive_ticket_list":
      return await callCore("ticket_list", { status: args.status, sprintId: args.sprintId, assigneeId: args.assigneeId, label: args.label });
    case "hive_ticket_get":
      return await callCore("ticket_get", { ticketId: args.ticketId });
    case "hive_ticket_claim":
      return await callCore("ticket_claim", { ticketId: args.ticketId, agentId: process.env.ZANA_TERMINAL_ID || "agent", agentName: process.env.ZANA_AGENT_NAME || "Agent", profileId: process.env.ZANA_PROFILE_ID || null });
    case "hive_ticket_update":
      return await callCore("ticket_update", { ticketId: args.ticketId, status: args.status, reviewPhase: args.reviewPhase, progress: args.progress, planification: args.planification, resultSummary: args.resultSummary, filesChanged: args.filesChanged, agentId: process.env.ZANA_TERMINAL_ID || "agent", agentName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "hive_ticket_update_status":
      return await callCore("ticket_update_status", { ticketId: args.ticketId, status: args.status, updatedBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "hive_ticket_comment":
      return await callCore("ticket_comment", { ticketId: args.ticketId, body: args.body, authorId: process.env.ZANA_TERMINAL_ID || "agent", authorName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "hive_ticket_complete":
      return await callCore("ticket_complete", { ticketId: args.ticketId, resultSummary: args.resultSummary, completedBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "hive_ticket_edit":
      return await callCore("ticket_edit", { ticketId: args.ticketId, title: args.title, description: args.description, priority: args.priority, labels: args.labels, type: args.type, sprintId: args.sprintId, updatedBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "hive_ticket_add_to_sprint":
      return await callCore("ticket_add_to_sprint", { ticketId: args.ticketId, sprintId: args.sprintId });
    case "hive_sprint_list":
      return await callCore("sprint_list", { teamId: args.teamId, status: args.status });
    case "hive_sprint_board":
      return await callCore("sprint_board", { sprintId: args.sprintId });
    case "hive_sprint_create":
      return await callCore("sprint_create", { name: args.name, teamId: args.teamId, ticketIds: args.ticketIds });
    case "hive_sprint_start":
      return await callCore("sprint_start", { sprintId: args.sprintId });
    case "hive_sprint_end":
      return await callCore("sprint_end", { sprintId: args.sprintId });

    // Scheduler tools
    case "hive_schedule_create":
      return await callCore("schedule_create", { name: args.name, description: args.description, cron: args.cron, intervalMs: args.intervalMs, action: args.action, enabled: args.enabled, ownerId: process.env.ZANA_TERMINAL_ID || "agent", ownerName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "hive_schedule_list":
      return await callCore("schedule_list");
    case "hive_schedule_get":
      return await callCore("schedule_get", { scheduleId: args.scheduleId });
    case "hive_schedule_update":
      return await callCore("schedule_update", { id: args.scheduleId, name: args.name, cron: args.cron, intervalMs: args.intervalMs, action: args.action, enabled: args.enabled });
    case "hive_schedule_delete":
      return await callCore("schedule_delete", { id: args.scheduleId });
    case "hive_schedule_enable":
      return await callCore("schedule_enable", { id: args.scheduleId });
    case "hive_schedule_disable":
      return await callCore("schedule_disable", { id: args.scheduleId });
    case "hive_schedule_trigger":
      return await callCore("schedule_trigger", { id: args.scheduleId });

    // Event Bus tools
    case "hive_event_emit":
      return await callCore("event_emit", { type: args.type, payload: args.payload, tags: args.tags, source: process.env.ZANA_TERMINAL_ID || "agent" });
    case "hive_event_query":
      return await callCore("event_query", { types: args.types, source: args.source, since: args.since, limit: args.limit || 50 });

    // P2P tools
    case "hive_discover_agents":
      return await callCore("discover_agents", { query: args.query });
    case "hive_ask_agent":
      return await callCore("ask_agent", { toAgentId: args.toAgentId, question: args.question, replyTo: args.replyTo, fromTerminalId: process.env.ZANA_TERMINAL_ID, fromAgentName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "hive_check_inbox":
      return await callCore("check_inbox", { terminalId: process.env.ZANA_TERMINAL_ID });

    // Typed messaging + channels
    case "hive_send_message":
      return await callCore("send_message", { toAgentId: args.toAgentId, type: args.type, payload: args.payload, priority: args.priority || "normal", replyTo: args.replyTo, requiresAck: args.requiresAck || false, fromAgentId: callerAgentId, fromAgentName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "hive_publish_channel":
      return await callCore("publish_channel", { channel: args.channel, type: args.type, payload: args.payload, fromAgentId: callerAgentId, fromAgentName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "hive_subscribe_channel":
      return await callCore("subscribe_channel", { channel: args.channel, agentId: callerAgentId });
    case "hive_list_channels":
      return await callCore("list_channels");
    case "hive_channel_history":
      return await callCore("channel_history", { channel: args.channel, limit: args.limit || 50 });
    case "hive_send_ack":
      return await callCore("send_ack", { messageId: args.messageId, status: args.status, response: args.response, agentId: callerAgentId });

    // Checkpoint tools
    case "hive_checkpoint_save":
      return await callCore("checkpoint_save", { teamId: args.teamId, pendingAgents: args.pendingAgents || [], status: "running" });
    case "hive_checkpoint_list":
      return await callCore("checkpoint_list", { teamId: args.teamId, status: args.status });
    case "hive_checkpoint_get":
      return await callCore("checkpoint_get", { checkpointId: args.checkpointId });
    case "hive_checkpoint_resume":
      return await callCore("checkpoint_resume", { checkpointId: args.checkpointId });

    // Workflow tools
    case "hive_workflow_run": {
      const workflowEngine = require("@zana/core").workflowEngine;
      const hiveSkillStoreWf = require("@zana/core").hiveSkillStore;
      const skill = hiveSkillStoreWf.getSkill(args.skillId);
      if (!skill || skill.type !== "workflow") return { error: "workflow skill not found" };
      let context: any = {};
      if (args.ticketId) {
        const ticketService = require("@zana/core").ticketService;
        context.ticket = ticketService.getTicket(args.ticketId);
      }
      return await workflowEngine.executeWorkflow(skill, context);
    }
    case "hive_workflow_list_runs": {
      const workflowEngine = require("@zana/core").workflowEngine;
      return workflowEngine.listRuns({ status: args.status });
    }
    case "hive_workflow_get_run": {
      const workflowEngine = require("@zana/core").workflowEngine;
      const run = workflowEngine.loadRun(args.runId);
      if (!run) return { error: "run not found" };
      return run;
    }

    // Artifact tools
    case "hive_artifact_create":
      return await callCore("artifact_create", { title: args.title, type: args.type, content: args.content, tags: args.tags, linkedTickets: args.linkedTickets, createdBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "hive_artifact_list":
      return await callCore("artifact_list", { type: args.type, tag: args.tag });
    case "hive_artifact_read":
      return await callCore("artifact_read", { artifactId: args.artifactId });
    case "hive_artifact_update":
      return await callCore("artifact_update", { artifactId: args.artifactId, title: args.title, content: args.content, tags: args.tags, linkedTickets: args.linkedTickets });

    // Master-only tools
    case "hive_mind_spawn_hive":
      return await callCore("mind_spawn_hive", { teamId: args.teamId, workspace: args.workspace, prompt: args.prompt });
    case "hive_mind_list_hives":
      return await callCore("mind_list_hives");
    case "hive_mind_instruct_hive":
      return await callCore("mind_instruct_hive", { hiveId: args.hiveId, message: args.message });
    case "hive_mind_stop_hive":
      return await callCore("mind_stop_hive", { hiveId: args.hiveId });
    case "hive_mind_broadcast":
      return await callCore("mind_broadcast", { message: args.message });
    case "hive_mind_poll_events":
      return await callCore("mind_poll_events", { since: args.since });

    default: {
      // Check dynamic hive tool skills
      const hiveSkill = hiveToolSkills.find((t) => t.schema.name === name);
      if (hiveSkill) {
        const handler = hiveSkill.skill.handler;
        if (handler === "scratchpad") return handleScratchpad(args);
        if (handler === "broadcast") return handleBroadcast(args);
        return { error: `no handler implemented for: ${handler}` };
      }

      // Check module-contributed tools
      const reg = getModuleToolRegistry();
      const moduleTool = reg.getModuleTool(name);
      if (moduleTool) {
        if (typeof moduleTool.handler === "function") {
          return await moduleTool.handler(args);
        }
        return await callCore("module_tool_call", { tool: name, moduleId: moduleTool.moduleId, args });
      }

      return { error: `unknown tool: ${name}` };
    }
  }
}

let initialized = false;

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "hive-orchestrator", version: "0.1.0" },
      });
      break;

    case "notifications/initialized":
      initialized = true;
      break;

    case "tools/list":
      if (!initialized) { sendError(id, -32002, "Server not yet initialized"); break; }
      sendResponse(id, { tools: getAllTools() });
      break;

    case "tools/call": {
      if (!initialized) { sendError(id, -32002, "Server not yet initialized"); break; }
      const { name, arguments: args } = params;
      try {
        const parentId = process.env.ZANA_TERMINAL_ID || null;
        const result = await handleToolCall(name, args || {}, parentId);
        const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];

        // Auto-append inbox messages to every tool response
        const inbox = await drainLocalInbox();
        if (inbox.length > 0) {
          const inboxText = inbox.map((m) =>
            `[INBOX] From ${m.fromAgentName || "Agent"}: ${m.body}` +
            (m.replyTo ? ` (reply to ${m.replyTo})` : "")
          ).join("\n");
          content.push({ type: "text", text: `\n--- INBOX (${inbox.length} message${inbox.length > 1 ? "s" : ""}) ---\n${inboxText}` });
        }

        sendResponse(id, { content });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${err.message || err}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id) sendError(id, -32601, `Method not found: ${method}`);
      break;
  }
}

// Read LSP-style messages from stdin (Content-Length header framing, byte-accurate)
let buffer = Buffer.alloc(0);
const HEADER_DELIMITER = Buffer.from("\r\n\r\n");
const MAX_CONTENT_LENGTH = MCP_MAX_BUFFER_BYTES;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  if (buffer.length > MCP_MAX_BUFFER_BYTES) {
    sendError(null, -32700, "Buffer overflow: stdin buffer exceeded 10 MB limit");
    buffer = Buffer.alloc(0);
    return;
  }

  while (true) {
    const headerEnd = buffer.indexOf(HEADER_DELIMITER);
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(match[1], 10);
    if (contentLength > MAX_CONTENT_LENGTH) {
      sendError(null, -32700, `Content-Length ${contentLength} exceeds maximum ${MAX_CONTENT_LENGTH}`);
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentStart = headerEnd + 4;
    if (buffer.length < contentStart + contentLength) break;

    const content = buffer.slice(contentStart, contentStart + contentLength).toString("utf8");
    buffer = buffer.slice(contentStart + contentLength);

    try {
      const msg = JSON.parse(content);
      handleMessage(msg).catch((err) => {
        process.stderr.write(`[orchestrator-mcp] unhandled tool error: ${err.message}\n`);
      });
    } catch (err) {
      process.stderr.write(`[orchestrator-mcp] parse error: ${err.message}\n`);
    }
  }
});

process.stdin.on("end", () => {
  if (localHive) localHive.shutdown();
  process.exit(0);
});

// Boot core eagerly so it's ready by the first tool call
ensureHiveRunning().catch((err) => {
  process.stderr.write(`[hive-mcp] bootstrap error: ${err.message}\n`);
});

process.on("SIGTERM", () => {
  if (localHive) localHive.shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  if (localHive) localHive.shutdown();
  process.exit(0);
});
