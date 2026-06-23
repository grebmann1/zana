#!/usr/bin/env node
export {};

// Orchestrator MCP Server (stdio, JSON-RPC 2.0)
// Boots core in-process — no external daemon required.
// Inspired by ruflo: the MCP server IS the runtime.
//
// Tool surface comes from per-domain registration files under
// `./registrations/`; this file is just the bootstrap (stdio framing,
// daemon boot, `tools/list` + `tools/call` dispatch, gating, inbox drain).

const path = require("node:path");

import { ZANA_DAEMON_TOOLS, DAEMON_GATED_TOOL_NAMES, isFrozen, EXPERIMENTAL_TOOL_NAMES } from "./gating";
import { isForwardable, forwardToDaemon, DaemonAuthError, authorityPortFor } from "./daemon-client";
import type { ToolDefinition, ToolContext } from "./types";
import { collectStaticTools, collectHandlers } from "./registrations";
import { loadToolSkills, handleScratchpad, isValidToolSchema } from "./dynamic-skills";

// MCP stdio protocol uses stdout for framed JSON-RPC only.
// Route normal logs to stderr to avoid corrupting the MCP stream.
const originalConsoleLog = console.log.bind(console);
console.log = (...args: any[]) => {
  try {
    process.stderr.write(args.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ") + "\n");
  } catch {
    originalConsoleLog(...args);
  }
};

const MCP_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB stdin buffer cap

if (!process.env.ZANA_TERMINAL_ID) {
  process.stderr.write(
    "[zana-mcp] WARNING: ZANA_TERMINAL_ID is not set. Ticket and agent attribution will fall back to \"agent\". " +
    "Set ZANA_TERMINAL_ID=<unique-session-id> in your MCP server env config (Cursor, Continue, Codex, etc.) " +
    "to get correct per-session tracking.\n",
  );
}

// --- In-process core (always boots — no daemon needed) ---
let localDaemon: any = null;
let bootstrapPromise: Promise<void> | null = null;

function getProjectInitModule() {
  // Reach project-init via the package root (core exposes it as `project.init`),
  // not a "@zana-ai/core/dist/src/..." deep import + monorepo-path fallback that
  // binds to core's internal file layout.
  return require("@zana-ai/core").project.init;
}

async function ensureDaemonRunning(): Promise<void> {
  if (localDaemon) return;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    // Workspace resolution — tenant isolation depends on this. Prefer an
    // explicit ZANA_WORKSPACE (what an MCP registration SHOULD set per
    // project); otherwise fall back to the launching process's cwd, which
    // Claude Code sets to the active project directory. We deliberately do
    // NOT fall back to __dirname: for a global `npx @zana-ai/mcp` install
    // that resolves into the npm cache, and for any install it points at
    // wherever the package lives rather than the user's project — silently
    // funneling every project's tickets/runs into one shared store. cwd is
    // the project; the package install dir is not.
    const workspace = process.env.ZANA_WORKSPACE || process.cwd();
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
    const { init: coreInit } = require("@zana-ai/core");
    localDaemon = await coreInit({
      workspace,
      headless: true,
      preferredPort: 0,
      skipApiServer: true,
      onHook: () => {},
    });

    process.stderr.write(
      `[zana-mcp] ready — id: ${localDaemon.daemonId} port: ${localDaemon.hookServerHandle?.port || "none"}\n`,
    );
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });

  return bootstrapPromise;
}

// ADR 0006: forward agent-lifecycle actions to a standalone HTTP daemon when
// one is running for this workspace, so it is the single authority for live
// agent state. Returns that daemon's apiPort, or null to use in-process core.
// "Co-workspace daemon" = a registered, alive entry with an apiPort that is NOT
// this MCP server's own in-process core (which registers without an apiPort,
// since it boots with skipApiServer:true). Cached; invalidated on a connection
// failure so a daemon dying mid-session falls back cleanly.
let cachedAuthorityPort: number | null | undefined; // undefined = not yet resolved
function resolveAgentAuthorityPort(): number | null {
  if (cachedAuthorityPort !== undefined) return cachedAuthorityPort;
  try {
    const registry = require("@zana-ai/core").daemon.registry;
    const ws = localDaemon?.workspace;
    const entry = registry.findRunningDaemon(ws);
    cachedAuthorityPort = authorityPortFor(entry, process.pid);
  } catch {
    cachedAuthorityPort = null;
  }
  return cachedAuthorityPort;
}

async function callCore(action: string, params: Record<string, unknown> = {}) {
  // Lifecycle actions forward to a co-workspace daemon if one exists (ADR 0006).
  if (isForwardable(action)) {
    const apiPort = resolveAgentAuthorityPort();
    if (apiPort) {
      try {
        return await forwardToDaemon(apiPort, action, params as Record<string, any>);
      } catch (err: any) {
        if (err instanceof DaemonAuthError) {
          // Do NOT silently fall back — that would re-fragment the registry
          // with a second authority. Surface the misconfiguration.
          return { error: `daemon authority unreachable: ${err.message}. Fix the auth token or stop the stale daemon.` };
        }
        // Unreachable (daemon died / no token): invalidate cache and fall back
        // to in-process core so the action still completes.
        cachedAuthorityPort = undefined;
        process.stderr.write(`[zana-mcp] daemon forward failed (${err?.message || err}); using in-process core\n`);
      }
    }
  }
  // Route under the reserved `_action` key so a parameter literally named
  // `action` (e.g. a schedule's action object in schedule_create/update) can't
  // clobber the routing command. See handleOrchestratorCommand for the contract.
  return localDaemon.agentManager.handleOrchestratorCommand(
    { _action: action, ...params },
    () => localDaemon.workspace,
  );
}

// --- Static + dynamic tool surface ---
const STATIC_TOOLS: ToolDefinition[] = collectStaticTools();
const HANDLERS = collectHandlers();
const toolSkills = loadToolSkills();
const DYNAMIC_TOOLS: ToolDefinition[] = toolSkills.map((t) => t.schema);

// Module tool registry (tools contributed by modules via api.mcp in module.json).
let moduleToolRegistry: any = null;
function getModuleToolRegistry() {
  if (!moduleToolRegistry) {
    try {
      moduleToolRegistry = require("@zana-ai/core").modules.toolRegistry;
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

function getAllTools(): ToolDefinition[] {
  const reg = getModuleToolRegistry();
  const moduleTools: ToolDefinition[] = reg.listModuleTools().map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: "object", properties: {} },
  }));
  const all: ToolDefinition[] = [...STATIC_TOOLS, ...moduleTools, ...DYNAMIC_TOOLS];
  // Final boundary guard: the MCP client validates every tool entry and
  // rejects the WHOLE `tools/list` batch if any one is malformed. Module- and
  // skill-contributed tools are not authored here, so drop any entry missing a
  // valid name/inputSchema rather than letting it poison the entire surface.
  const valid = all.filter((t) => {
    if (isValidToolSchema(t)) return true;
    process.stderr.write(`[zana-mcp] dropping malformed tool from tools/list: ${JSON.stringify(t?.name)}\n`);
    return false;
  });
  // Frozen subsystems (ADR 0009): GOAP planner + vector-memory tools are hidden
  // unless their ZANA_*_EXPERIMENTAL flag is set. Applied regardless of the
  // daemon-tools gate.
  const surfaced = valid.filter((t) => !isFrozen(t.name));
  if (ZANA_DAEMON_TOOLS) return surfaced;
  // Default install: hide daemon-only duplicates of native Claude Code flows.
  return surfaced.filter((t) => !DAEMON_GATED_TOOL_NAMES.has(t.name));
}

// --- JSON-RPC framing ---
function sendResponse(id: any, result: any) {
  const msg = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendError(id: any, code: number, message: string) {
  const msg = { jsonrpc: "2.0", id, error: { code, message } };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function drainLocalInbox(): any[] {
  const agentId = process.env.ZANA_TERMINAL_ID;
  if (!agentId || !localDaemon?.swarmRouter) return [];
  try {
    return localDaemon.swarmRouter.drainInbox(agentId) || [];
  } catch {
    return [];
  }
}

async function handleToolCall(name: string, args: any, callerAgentId: string | null): Promise<any> {
  await ensureDaemonRunning();

  // Reject calls to daemon-gated tools when the gate is closed. Mirrors the
  // visibility filter in `getAllTools()` so a client cannot bypass tools/list
  // by invoking the tool by name directly.
  if (!ZANA_DAEMON_TOOLS && DAEMON_GATED_TOOL_NAMES.has(name)) {
    return {
      error: `Tool '${name}' is daemon-only. Set ZANA_DAEMON_TOOLS=1 in the MCP server env to enable, or use the native Claude Code primitive (Agent + SendMessage, /zana:autopilot, /zana:council, /zana:team).`,
    };
  }

  // Frozen subsystems (ADR 0009): reject a call to a frozen tool when its flag
  // is off — mirrors the visibility filter so a client can't bypass tools/list.
  if (isFrozen(name)) {
    const flag = EXPERIMENTAL_TOOL_NAMES.get(name);
    return {
      error: `Tool '${name}' is part of a frozen/experimental subsystem and is not enabled. Set ${flag}=1 in the MCP server env to enable it.`,
    };
  }

  const ctx: ToolContext = {
    callCore,
    callerAgentId,
    getDaemon: () => localDaemon,
  };

  // Static + per-domain handlers
  const handler = HANDLERS[name];
  if (handler) {
    return await handler(args, ctx);
  }

  // Dynamic tool skills (e.g. scratchpad)
  const toolSkill = toolSkills.find((t) => t.schema.name === name);
  if (toolSkill) {
    const handlerName = toolSkill.skill.handler;
    if (handlerName === "scratchpad") return handleScratchpad(args);
    return { error: `no handler implemented for: ${handlerName}` };
  }

  // Module-contributed tools
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

let initialized = false;

async function handleMessage(msg: any) {
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
        const content: any[] = [{ type: "text", text: JSON.stringify(result, null, 2) }];

        // Auto-append inbox messages to every tool response
        const inbox = drainLocalInbox();
        if (inbox.length > 0) {
          const inboxText = inbox
            .map((m) =>
              `[INBOX] From ${m.fromAgentName || "Agent"}: ${m.body}` +
              (m.replyTo ? ` (reply to ${m.replyTo})` : ""),
            )
            .join("\n");
          content.push({
            type: "text",
            text: `\n--- INBOX (${inbox.length} message${inbox.length > 1 ? "s" : ""}) ---\n${inboxText}`,
          });
        }

        sendResponse(id, { content });
      } catch (err: any) {
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

// Read newline-delimited JSON messages from stdin (MCP stdio transport).
let stdinBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  stdinBuffer += chunk;

  if (stdinBuffer.length > MCP_MAX_BUFFER_BYTES) {
    sendError(null, -32700, "Buffer overflow: stdin buffer exceeded 10 MB limit");
    stdinBuffer = "";
    return;
  }

  let newlineIdx: number;
  while ((newlineIdx = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.slice(0, newlineIdx).trim();
    stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      handleMessage(msg).catch((err) => {
        process.stderr.write(`[zana-mcp] unhandled tool error: ${err.message}\n`);
      });
    } catch (err: any) {
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
