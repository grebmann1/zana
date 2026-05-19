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

// Lazy getters for cross-package modules — Node's require cache makes repeat calls cheap.
// Do NOT memoize into module-scope vars; that defeats the cycle break.
function _workflowEngine() { return require("@zana/work").scheduling.workflowEngine; }
function _ticketServiceMcp() { return require("@zana/work").tickets.service; }
function _skillStoreMcp() { return require("@zana/extras").settings.skillStore; }
function _moduleConfigMcp() { return require("@zana/core").modules.config; }

const MCP_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB stdin buffer cap

const ZANA_MASTER_MODE = process.env.ZANA_MASTER_MODE === "true";
const ZANA_ID = process.env.ZANA_ID || "mcp";
const SCRATCHPAD_PATH = path.join(SCRATCHPAD_DIR, `${ZANA_ID}.md`);

// --- In-process core (always boots — no daemon needed) ---
let localDaemon = null;
let bootstrapPromise = null;

function getProjectInitModule() {
  try {
    return require("@zana/core/dist/src/project/init.js");
  } catch {
    const appRoot = path.resolve(__dirname, "..", "..", "..", "..");
    return require(path.join(appRoot, "packages", "core", "dist", "src", "project", "init.js"));
  }
}

async function ensureDaemonRunning() {
  if (localDaemon) return;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const workspace = process.env.ZANA_WORKSPACE || require("path").resolve(__dirname, "..", "..", "..", "..");
    process.stderr.write(`[zana-mcp] booting core in-process for: ${workspace}\n`);

    const autoInitDisabled = process.env.ZANA_AUTO_INIT === "0";
    if (!autoInitDisabled) {
      const { isProjectInitialized, initProjectDir } = getProjectInitModule();
      if (!isProjectInitialized(workspace)) {
        initProjectDir(workspace, { silent: true });
        process.stderr.write(`[zana-mcp] initialized .zana in workspace: ${workspace}\n`);
      }
    }

    process.env.ZANA_SKIP_MCP_INSTALL = "1";
    const { init: coreInit } = require("@zana/core");
    localDaemon = await coreInit({
      workspace,
      headless: true,
      preferredPort: 0,
      skipApiServer: true,
      onHook: () => {},
    });

    process.stderr.write(`[zana-mcp] ready — id: ${localDaemon.daemonId} port: ${localDaemon.hookServerHandle?.port || "none"}\n`);
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });

  return bootstrapPromise;
}

function callCore(action, params = {}) {
  return localDaemon.agentManager.handleOrchestratorCommand(
    { action, ...params },
    () => localDaemon.workspace
  );
}

const TOOLS = [
  {
    name: "zana_spawn_agent",
    description: "Spawn a sub-agent from an available profile. The agent runs in headless mode and works on the current project.",
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
    name: "zana_oneshot_query",
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
    name: "zana_list_agents",
    description: "List all currently running agents with their status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "zana_agent_status",
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
    name: "zana_agent_result",
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
    name: "zana_kill_agent",
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
    name: "zana_list_profiles",
    description: "List all available agent profiles that can be spawned.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "zana_get_profile",
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
    name: "zana_save_profile",
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
    name: "zana_delete_profile",
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
    name: "zana_list_skills",
    description: "List all Skills (shared instructions and tools injected into all agents).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "zana_get_skill",
    description: "Get a specific Skill by ID.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID to retrieve" },
      },
      required: ["skillId"],
    },
  },
  {
    name: "zana_save_skill",
    description: "Create or update a Skill. For instruction type: provide content (markdown text injected into agent system prompts). For tool type: provide toolSchema and handler.",
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
      properties: {
        skillId: { type: "string", description: "Skill ID to delete" },
      },
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
];

// --- Ticket tools ---
const TICKET_TOOLS = [
  {
    name: "zana_ticket_create",
    description: "Create a new ticket for tracking work. Tickets are globally shared across all daemons.",
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
    name: "zana_ticket_list",
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
    name: "zana_ticket_get",
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
    name: "zana_ticket_claim",
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
    name: "zana_ticket_update_status",
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
    name: "zana_ticket_comment",
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
    name: "zana_ticket_complete",
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
    name: "zana_ticket_edit",
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
    name: "zana_ticket_update",
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
    name: "zana_ticket_add_to_sprint",
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
    name: "zana_sprint_list",
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
    name: "zana_sprint_board",
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
    name: "zana_sprint_create",
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
    name: "zana_sprint_start",
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
    name: "zana_sprint_end",
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

// --- Team tools ---
const TEAM_TOOLS = [
  {
    name: "zana_list_teams",
    description: "List all configured team templates (name, orchestrator profile, worker profiles, slot counts).",
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
    name: "zana_list_running_teams",
    description: "List all currently running teams with their statuses.",
    inputSchema: { type: "object", properties: {} },
  },
];

// --- Scheduler tools ---
const SCHEDULER_TOOLS = [
  {
    name: "zana_schedule_create",
    description:
      "Create a scheduled recurring action. New schedules are persisted as YAML in <workspace>/.zana/scheduler/<id>.yml. Supports a 5-field cron expression OR an intervalMs OR an `every` shorthand (e.g. '5m', '1h', '2d'). Cron schedules fire via node-cron in the daemon and survive restarts.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for this schedule" },
        description: { type: "string" },
        cron: { type: "string", description: "5-field cron expression (min hour dom mon dow). Takes precedence over intervalMs/every." },
        intervalMs: { type: "number", description: "Simple interval in milliseconds (alternative to cron)" },
        every: { type: "string", description: "Shorthand interval, e.g. '5m', '1h', '30s', '2d'. Resolved to intervalMs internally." },
        action: {
          type: "object",
          description: "Action to execute when the schedule fires",
          properties: {
            type: { type: "string", enum: ["prompt", "spawn-agent", "team", "command", "workflow", "mcp_tool"] },
            profileId: { type: "string" },
            prompt: { type: "string" },
            teamId: { type: "string" },
            command: { type: "array", items: { type: "string" }, description: "argv array — first element is the binary, rest are args. Shell strings are rejected for safety. Example: [\"npm\", \"run\", \"build\"]" },
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
      properties: {
        scheduleId: { type: "string" },
      },
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
      properties: {
        scheduleId: { type: "string" },
      },
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
];

// --- Event Bus tools ---
const EVENT_BUS_TOOLS = [
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
];

// --- P2P tools (available to ALL agents) ---
const P2P_TOOLS = [
  {
    name: "zana_discover_agents",
    description: "Discover agents across the entire swarm. Returns agent IDs, names, profiles, and which daemon they belong to. Use this to find agents you can ask questions to.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search filter (matches agent name, profile, ID)" },
      },
    },
  },
  {
    name: "zana_ask_agent",
    description: "Send a question to another agent (P2P). Questions are read-only — you cannot give instructions, only ask. The agent will see your question in their inbox on their next tool call.",
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
    description: "Explicitly check your inbox for P2P messages from other agents. Messages are also auto-appended to tool responses, but use this to check proactively.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "zana_send_message",
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
    name: "zana_publish_channel",
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
      properties: {
        moduleId: { type: "string", description: "Module ID to get config for" },
      },
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
];

// --- Checkpoint tools ---
const CHECKPOINT_TOOLS = [
  {
    name: "zana_checkpoint_save",
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
    name: "zana_checkpoint_list",
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
    name: "zana_checkpoint_get",
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
    name: "zana_checkpoint_resume",
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
    name: "zana_workflow_run",
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
    name: "zana_workflow_list_runs",
    description: "List workflow runs, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["running", "completed", "halted", "failed"], description: "Filter by status" },
      },
    },
  },
  {
    name: "zana_workflow_get_run",
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
    name: "zana_artifact_create",
    description: "Create a planning artifact (architecture doc, requirement spec, design doc, etc.) that is shared with all daemons. Use this to document plans, decisions, and specs before implementation.",
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
    name: "zana_artifact_list",
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
    name: "zana_artifact_read",
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
    name: "zana_artifact_update",
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

// --- Master-only tools (spawn/control child daemons) ---
const MASTER_TOOLS = ZANA_MASTER_MODE ? [
  {
    name: "zana_swarm_spawn",
    description: "Spawn a new child daemon (headless team). The child daemon runs as a child process and can be controlled via instructions.",
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "Team ID to start in the child daemon (optional — omit to spawn a single orchestrator)" },
        workspace: { type: "string", description: "Working directory for the child daemon (defaults to current workspace)" },
        prompt: { type: "string", description: "Initial prompt/task for the child daemon" },
      },
    },
  },
  {
    name: "zana_swarm_list",
    description: "List all spawned child daemons with their status, ports, and team info.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "zana_swarm_instruct",
    description: "Send an instruction to a child daemon's team lead. Instructions flow DOWN only (master → team lead → workers).",
    inputSchema: {
      type: "object",
      properties: {
        daemonId: { type: "string", description: "Child daemon ID to instruct" },
        message: { type: "string", description: "Instruction message for the team lead" },
      },
      required: ["daemonId", "message"],
    },
  },
  {
    name: "zana_swarm_stop",
    description: "Stop a child daemon. Sends SIGTERM to the child process.",
    inputSchema: {
      type: "object",
      properties: {
        daemonId: { type: "string", description: "Child daemon ID to stop" },
      },
      required: ["daemonId"],
    },
  },
  {
    name: "zana_swarm_broadcast",
    description: "Send a message to ALL running child daemons. Each team lead receives the instruction.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to broadcast to all child daemon team leads" },
      },
      required: ["message"],
    },
  },
  {
    name: "zana_swarm_poll_events",
    description: "Poll events from child daemons (progress reports, decision requests, completions, errors).",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Timestamp (ms) — only return events after this time. Omit for all." },
      },
    },
  },
] : [];

// Load dynamic swarm tool skills
function loadToolSkills() {
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
        process.stderr.write(`[zana-mcp] failed to load skill ${f}: ${err.message}\n`);
      }
    }
    return tools;
  } catch (err) {
    if (err.code !== "ENOENT") {
      process.stderr.write(`[zana-mcp] failed to read skills dir: ${err.message}\n`);
    }
    return [];
  }
}

const AUTOPILOT_TOOLS = [
  {
    name: "zana_autopilot_goal_driven",
    description: "Start a goal-driven task that loops a sequence of agent steps until success criteria are met. Returns the goal ID immediately; run autopilot_goal_status to check progress.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title — what you want to achieve" },
        criteria: { type: "string", description: "Success conditions — what must be true for the goal to be 'done'. The evaluator agent judges these." },
        steps: {
          type: "array",
          description: "Ordered list of agent invocations. Each step spawns one agent. On failure, the loop restarts from step 0 with feedback.",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "Prompt for this step's agent" },
              profile: { type: "string", description: "Profile ID to use" },
            },
            required: ["prompt", "profile"],
          },
        },
      },
      required: ["title", "criteria", "steps"],
    },
  },
  {
    name: "zana_autopilot_goal_status",
    description: "Get the status of a goal-driven task by ID. Returns: status (running/completed/failed/exhausted/cancelled), iteration count, latest evaluation result.",
    inputSchema: {
      type: "object",
      properties: { goalId: { type: "string" } },
      required: ["goalId"],
    },
  },
  {
    name: "zana_autopilot_goal_list",
    description: "List all autopilot goals (filterable by status).",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", description: "Filter by status: running, completed, failed, exhausted, cancelled" } },
    },
  },
  {
    name: "zana_autopilot_goal_cancel",
    description: "Cancel a running goal.",
    inputSchema: {
      type: "object",
      properties: { goalId: { type: "string" } },
      required: ["goalId"],
    },
  },
];

// T9 — Deliberation MCP tools (zana_deliberate + companions).
const { DELIBERATION_TOOLS, deliberateHandler, deliberationStatusHandler, deliberationListHandler, deliberationOverrideHandler } = require("./tools/deliberate");

const toolSkills = loadToolSkills();
const DYNAMIC_TOOLS = toolSkills.map((t) => t.schema);
const STATIC_TOOLS = [...TOOLS, ...TICKET_TOOLS, ...TEAM_TOOLS, ...INTELLIGENCE_TOOLS, ...CHECKPOINT_TOOLS, ...WORKFLOW_TOOLS, ...ARTIFACT_TOOLS, ...SCHEDULER_TOOLS, ...EVENT_BUS_TOOLS, ...P2P_TOOLS, ...MASTER_TOOLS, ...AUTOPILOT_TOOLS, ...DELIBERATION_TOOLS, ...DYNAMIC_TOOLS];

// Module tool registry (tools contributed by modules via api.mcp in module.json)
let moduleToolRegistry = null;
function getModuleToolRegistry() {
  if (!moduleToolRegistry) {
    try {
      moduleToolRegistry = require("@zana/core").modules.toolRegistry;
    } catch {
      try {
        moduleToolRegistry = require(path.resolve(__dirname, "../../../core/dist/src/modules/tool-registry.js"));
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
  if (localDaemon && localDaemon.swarmRouter) {
    localDaemon.swarmRouter.broadcast(args.message || "");
    return { ok: true };
  }
  return { ok: false, error: "swarm not available" };
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
  if (!agentId || !localDaemon?.swarmRouter) return [];
  try {
    return localDaemon.swarmRouter.drainInbox(agentId) || [];
  } catch {
    return [];
  }
}

async function handleToolCall(name, args, callerAgentId) {
  await ensureDaemonRunning();

  switch (name) {
    case "zana_spawn_agent":
      return await callCore("spawn_agent", { profileId: args.profileId, prompt: args.prompt, parentAgentId: callerAgentId });
    case "zana_spawn_agent_validated":
      return await callCore("spawn_agent_validated", { profileId: args.profileId, prompt: args.prompt, parentAgentId: callerAgentId, guardrails: args.guardrails || [], maxRetries: args.maxRetries });
    case "zana_oneshot_query":
      return await callCore("spawn_oneshot", { profileId: args.profileId, prompt: args.prompt, timeout: args.timeout });
    case "zana_list_agents":
      return await callCore("list_agents");
    case "zana_agent_status":
      return await callCore("agent_status", { agentId: args.agentId });
    case "zana_agent_result":
      return await callCore("agent_result", { agentId: args.agentId });
    case "zana_kill_agent":
      return await callCore("kill_agent", { agentId: args.agentId });
    case "zana_list_profiles":
      return await callCore("list_profiles");
    case "zana_get_profile":
      return await callCore("get_profile", { profileId: args.profileId });
    case "zana_save_profile":
      return await callCore("save_profile", { profile: args.profile });
    case "zana_delete_profile":
      return await callCore("delete_profile", { profileId: args.profileId });
    case "zana_list_skills":
      return await callCore("list_skills");
    case "zana_get_skill":
      return await callCore("get_skill", { skillId: args.skillId });
    case "zana_save_skill":
      return await callCore("save_skill", { skill: args.skill });
    case "zana_delete_skill":
      return await callCore("delete_skill", { skillId: args.skillId });
    case "zana_toggle_skill":
      return await callCore("toggle_skill", { skillId: args.skillId, enabled: args.enabled });

    // Intelligence tools (direct module access)
    case "zana_route_task": {
      const ticket = { title: args.prompt, description: args.context || "", labels: [] };
      return localDaemon.taskRouter.route(ticket);
    }
    case "zana_memory_store": {
      const metadata = { ...(args.metadata || {}), tags: args.tags || [] };
      return localDaemon.vectorMemory.store({ content: args.content, metadata });
    }
    case "zana_memory_search": {
      return localDaemon.vectorMemory.search(args.query, { limit: args.limit || 5, tags: args.tags || [] });
    }
    case "zana_plan_create": {
      const options: any = {};
      if (args.constraints) options.constraints = args.constraints;
      if (args.currentState) options.initialState = args.currentState;
      return localDaemon.goapPlanner.createPlan(args.goal, options);
    }
    case "zana_workers_list": {
      return localDaemon.backgroundWorkers.list();
    }
    case "zana_module_config_list": {
      const cfg = _moduleConfigMcp().get();
      return cfg.modules || {};
    }
    case "zana_module_config_get": {
      return _moduleConfigMcp().getModuleConfig(args.moduleId);
    }
    case "zana_module_config_set": {
      const moduleConfig = _moduleConfigMcp();
      const current = moduleConfig.getModuleConfig(args.moduleId);
      const config = { ...(current.config || {}), [args.key]: args.value };
      moduleConfig.setModuleConfig(args.moduleId, { ...current, config });
      return { ok: true, moduleId: args.moduleId, key: args.key, value: args.value };
    }

    // Ticket tools
    case "zana_ticket_create":
      return await callCore("ticket_create", { title: args.title, description: args.description, priority: args.priority, labels: args.labels, blockedBy: args.blockedBy, sprintId: args.sprintId, createdBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "zana_ticket_list":
      return await callCore("ticket_list", { status: args.status, sprintId: args.sprintId, assigneeId: args.assigneeId, label: args.label });
    case "zana_ticket_get":
      return await callCore("ticket_get", { ticketId: args.ticketId });
    case "zana_ticket_claim":
      return await callCore("ticket_claim", { ticketId: args.ticketId, agentId: process.env.ZANA_TERMINAL_ID || "agent", agentName: process.env.ZANA_AGENT_NAME || "Agent", profileId: process.env.ZANA_PROFILE_ID || null });
    case "zana_ticket_update":
      return await callCore("ticket_update", { ticketId: args.ticketId, status: args.status, reviewPhase: args.reviewPhase, progress: args.progress, planification: args.planification, resultSummary: args.resultSummary, filesChanged: args.filesChanged, agentId: process.env.ZANA_TERMINAL_ID || "agent", agentName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "zana_ticket_update_status":
      return await callCore("ticket_update_status", { ticketId: args.ticketId, status: args.status, updatedBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "zana_ticket_comment":
      return await callCore("ticket_comment", { ticketId: args.ticketId, body: args.body, authorId: process.env.ZANA_TERMINAL_ID || "agent", authorName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "zana_ticket_complete":
      return await callCore("ticket_complete", { ticketId: args.ticketId, resultSummary: args.resultSummary, completedBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "zana_ticket_edit":
      return await callCore("ticket_edit", { ticketId: args.ticketId, title: args.title, description: args.description, priority: args.priority, labels: args.labels, type: args.type, sprintId: args.sprintId, updatedBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "zana_ticket_add_to_sprint":
      return await callCore("ticket_add_to_sprint", { ticketId: args.ticketId, sprintId: args.sprintId });
    case "zana_sprint_list":
      return await callCore("sprint_list", { teamId: args.teamId, status: args.status });
    case "zana_sprint_board":
      return await callCore("sprint_board", { sprintId: args.sprintId });
    case "zana_sprint_create":
      return await callCore("sprint_create", { name: args.name, teamId: args.teamId, ticketIds: args.ticketIds });
    case "zana_sprint_start":
      return await callCore("sprint_start", { sprintId: args.sprintId });
    case "zana_sprint_end":
      return await callCore("sprint_end", { sprintId: args.sprintId });

    // Team tools
    case "zana_list_teams":
      return await callCore("list_teams");
    case "zana_get_team":
      return await callCore("get_team", { teamId: args.teamId });
    case "zana_start_team":
      return await callCore("start_team", { teamId: args.teamId, prompt: args.prompt, cwd: args.cwd });
    case "zana_stop_team":
      return await callCore("stop_team", { teamId: args.teamId });
    case "zana_team_status":
      return await callCore("team_status", { teamId: args.teamId });
    case "zana_list_running_teams":
      return await callCore("list_running_teams");

    // Scheduler tools
    case "zana_schedule_create":
      return await callCore("schedule_create", { name: args.name, description: args.description, cron: args.cron, intervalMs: args.intervalMs, every: args.every, action: args.action, enabled: args.enabled, ownerId: process.env.ZANA_TERMINAL_ID || "agent", ownerName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "zana_schedule_list":
      return await callCore("schedule_list");
    case "zana_schedule_get":
      return await callCore("schedule_get", { scheduleId: args.scheduleId });
    case "zana_schedule_update":
      return await callCore("schedule_update", { id: args.scheduleId, name: args.name, cron: args.cron, intervalMs: args.intervalMs, action: args.action, enabled: args.enabled });
    case "zana_schedule_delete":
      return await callCore("schedule_delete", { id: args.scheduleId });
    case "zana_schedule_enable":
      return await callCore("schedule_enable", { id: args.scheduleId });
    case "zana_schedule_disable":
      return await callCore("schedule_disable", { id: args.scheduleId });
    case "zana_schedule_trigger":
      return await callCore("schedule_trigger", { id: args.scheduleId });
    case "zana_schedule_reload":
      return await callCore("schedule_reload");

    // Event Bus tools
    case "zana_event_emit":
      return await callCore("event_emit", { type: args.type, payload: args.payload, tags: args.tags, source: process.env.ZANA_TERMINAL_ID || "agent" });
    case "zana_event_query":
      return await callCore("event_query", { types: args.types, source: args.source, since: args.since, limit: args.limit || 50 });

    // P2P tools
    case "zana_discover_agents":
      return await callCore("discover_agents", { query: args.query });
    case "zana_ask_agent":
      return await callCore("ask_agent", { toAgentId: args.toAgentId, question: args.question, replyTo: args.replyTo, fromTerminalId: process.env.ZANA_TERMINAL_ID, fromAgentName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "zana_check_inbox":
      return await callCore("check_inbox", { terminalId: process.env.ZANA_TERMINAL_ID });

    // Typed messaging + channels
    case "zana_send_message":
      return await callCore("send_message", { toAgentId: args.toAgentId, type: args.type, payload: args.payload, priority: args.priority || "normal", replyTo: args.replyTo, requiresAck: args.requiresAck || false, fromAgentId: callerAgentId, fromAgentName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "zana_publish_channel":
      return await callCore("publish_channel", { channel: args.channel, type: args.type, payload: args.payload, fromAgentId: callerAgentId, fromAgentName: process.env.ZANA_AGENT_NAME || "Agent" });
    case "zana_subscribe_channel":
      return await callCore("subscribe_channel", { channel: args.channel, agentId: callerAgentId });
    case "zana_list_channels":
      return await callCore("list_channels");
    case "zana_channel_history":
      return await callCore("channel_history", { channel: args.channel, limit: args.limit || 50 });
    case "zana_send_ack":
      return await callCore("send_ack", { messageId: args.messageId, status: args.status, response: args.response, agentId: callerAgentId });

    // Checkpoint tools
    case "zana_checkpoint_save":
      return await callCore("checkpoint_save", { teamId: args.teamId, pendingAgents: args.pendingAgents || [], status: "running" });
    case "zana_checkpoint_list":
      return await callCore("checkpoint_list", { teamId: args.teamId, status: args.status });
    case "zana_checkpoint_get":
      return await callCore("checkpoint_get", { checkpointId: args.checkpointId });
    case "zana_checkpoint_resume":
      return await callCore("checkpoint_resume", { checkpointId: args.checkpointId });

    // Workflow tools
    case "zana_workflow_run": {
      const skill = _skillStoreMcp().getSkill(args.skillId);
      if (!skill || skill.type !== "workflow") return { error: "workflow skill not found" };
      let context: any = {};
      if (args.ticketId) {
        context.ticket = _ticketServiceMcp().getTicket(args.ticketId);
      }
      return await _workflowEngine().executeWorkflow(skill, context);
    }
    case "zana_workflow_list_runs": {
      return _workflowEngine().listRuns({ status: args.status });
    }
    case "zana_workflow_get_run": {
      const run = _workflowEngine().loadRun(args.runId);
      if (!run) return { error: "run not found" };
      return run;
    }

    // Artifact tools
    case "zana_artifact_create":
      return await callCore("artifact_create", { title: args.title, type: args.type, content: args.content, tags: args.tags, linkedTickets: args.linkedTickets, createdBy: process.env.ZANA_TERMINAL_ID || "agent" });
    case "zana_artifact_list":
      return await callCore("artifact_list", { type: args.type, tag: args.tag });
    case "zana_artifact_read":
      return await callCore("artifact_read", { artifactId: args.artifactId });
    case "zana_artifact_update":
      return await callCore("artifact_update", { artifactId: args.artifactId, title: args.title, content: args.content, tags: args.tags, linkedTickets: args.linkedTickets });

    // Master-only tools
    case "zana_swarm_spawn":
      return await callCore("swarm_spawn", { teamId: args.teamId, workspace: args.workspace, prompt: args.prompt });
    case "zana_swarm_list":
      return await callCore("swarm_list");
    case "zana_swarm_instruct":
      return await callCore("swarm_instruct", { daemonId: args.daemonId, message: args.message });
    case "zana_swarm_stop":
      return await callCore("swarm_stop", { daemonId: args.daemonId });
    case "zana_swarm_broadcast":
      return await callCore("swarm_broadcast", { message: args.message });
    case "zana_swarm_poll_events":
      return await callCore("swarm_poll_events", { since: args.since });

    // Goal-driven autopilot
    case "zana_autopilot_goal_driven": {
      const ml = require("@zana/core").modules.loader;
      const ap = ml.getModule?.("autopilot");
      if (!ap?.api) return { error: "autopilot module not available" };
      return await ap.api.setGoal(args);
    }
    case "zana_autopilot_goal_status": {
      const ml = require("@zana/core").modules.loader;
      const ap = ml.getModule?.("autopilot");
      if (!ap?.api) return { error: "autopilot module not available" };
      return ap.api.getGoal(args.goalId) || { error: "unknown goalId" };
    }
    case "zana_autopilot_goal_list": {
      const ml = require("@zana/core").modules.loader;
      const ap = ml.getModule?.("autopilot");
      if (!ap?.api) return { error: "autopilot module not available" };
      return ap.api.listGoals(args || {});
    }
    case "zana_autopilot_goal_cancel": {
      const ml = require("@zana/core").modules.loader;
      const ap = ml.getModule?.("autopilot");
      if (!ap?.api) return { error: "autopilot module not available" };
      return ap.api.cancelGoal(args.goalId);
    }

    // Deliberation tools (T9)
    case "zana_deliberate":
      return await deliberateHandler(args);
    case "zana_deliberation_status":
      return deliberationStatusHandler(args);
    case "zana_deliberation_list":
      return deliberationListHandler(args || {});
    case "zana_deliberation_override":
      return deliberationOverrideHandler(args);

    default: {
      // Check dynamic swarm tool skills
      const toolSkill = toolSkills.find((t) => t.schema.name === name);
      if (toolSkill) {
        const handler = toolSkill.skill.handler;
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
        serverInfo: { name: "zana", version: "0.1.0" },
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
        process.stderr.write(`[zana-mcp] unhandled tool error: ${err.message}\n`);
      });
    } catch (err) {
      process.stderr.write(`[zana-mcp] parse error: ${err.message}\n`);
    }
  }
});

process.stdin.on("end", () => {
  if (localDaemon) localDaemon.shutdown();
  process.exit(0);
});

// Boot core eagerly so it's ready by the first tool call
ensureDaemonRunning().catch((err) => {
  process.stderr.write(`[zana-mcp] bootstrap error: ${err.message}\n`);
});

process.on("SIGTERM", () => {
  if (localDaemon) localDaemon.shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  if (localDaemon) localDaemon.shutdown();
  process.exit(0);
});
