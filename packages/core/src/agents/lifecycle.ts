// Agent lifecycle: spawn (interactive + headless), kill, status, change-listeners,
// probe-overload state, and load-gate.
//
// Module-level state lives here (the agents Map, changeListeners, snapshotTimer,
// spawnOverloadStreaks) and is the single source of truth shared across the
// other agents/* split modules (dispatch, team-runtime, probe-agent). The thin
// manager.ts facade re-exports the public surface from this file.

import { buildInteractiveCommand, spawnHeadless } from "./spawner";
import { selectModel } from "./model-router";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as persistence from "../persistence";
import { bus, EVENTS } from "../events/bus";
import { MAX_CONCURRENT_AGENTS } from "../config";
import * as moduleConfig from "../modules/config";

// Lazy-load pty-host only when interactive mode is needed (requires node-pty native module)
let _ptyHost: any = null;
function getPtyHost() {
  if (!_ptyHost) {
    try {
      _ptyHost = require("./pty-host");
    } catch (err: any) {
      throw new Error(
        `pty-host unavailable (node-pty not installed). Interactive mode requires node-pty. Error: ${err.message}`
      );
    }
  }
  return _ptyHost;
}

export function getMaxConcurrentAgents() {
  const cfg = moduleConfig.get();
  return Number(process.env.ZANA_MAX_WORKERS) || cfg?.system?.maxConcurrentAgents || MAX_CONCURRENT_AGENTS;
}

/**
 * Resource gate. severity="soft" (default) blocks individual agent spawns
 * when load exceeds cpuLoadThreshold * cores. severity="hard" only blocks
 * when load exceeds cpuLoadHardCap * cores — used for whole-team starts,
 * which represent multi-agent commitments and should refuse outright on
 * a melted box rather than partially commit. Returns null when ok, or a
 * human-readable reason string.
 */
export function checkSystemResources(severity: "soft" | "hard" = "soft") {
  const cfg = moduleConfig.get()?.system;
  const cpuSoft = cfg?.cpuLoadThreshold ?? 0.8;
  const cpuHard = cfg?.cpuLoadHardCap ?? 2.0;
  const factor = severity === "hard" ? cpuHard : cpuSoft;

  const load1m = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const maxLoad = cpuCount * factor;
  if (load1m > maxLoad) {
    return `CPU load too high: ${load1m.toFixed(2)} exceeds ${severity} threshold ${maxLoad.toFixed(2)} (${cpuCount} cores x ${(factor * 100).toFixed(0)}%)`;
  }

  return null;
}

/**
 * Per-parent overload streak counter. When the daemon repeatedly refuses
 * a parent's spawns due to soft-load throttling, we eventually return a
 * TERMINAL error (rather than the same retryable one) so the orchestrator
 * knows to stop burning turns. Cleared on any successful spawn from that
 * parent. Top-level (parentAgentId=null) requests share the "" key.
 */
export const spawnOverloadStreaks = new Map<string, number>();

export function recordSpawnOverload(parentAgentId: string | null | undefined) {
  const key = parentAgentId || "";
  spawnOverloadStreaks.set(key, (spawnOverloadStreaks.get(key) || 0) + 1);
  return spawnOverloadStreaks.get(key) || 0;
}

export function clearSpawnOverloadStreak(parentAgentId: string | null | undefined) {
  const key = parentAgentId || "";
  spawnOverloadStreaks.delete(key);
}

export function getSpawnThrottleStreakLimit() {
  const cfg = moduleConfig.get()?.system;
  return cfg?.spawnThrottleStreakLimit ?? 5;
}

const agents = new Map<string, any>();

let changeListeners: Array<(snapshot: any[]) => void> = [];

let snapshotTimer: any = null;

function notifyChange() {
  const snapshot = listAgents();
  for (const cb of changeListeners) {
    try {
      cb(snapshot);
    } catch (err: any) {
      console.warn("[agent-manager] listener callback error:", err.message || err);
    }
  }
  // Debounced snapshot to disk
  if (!snapshotTimer) {
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      persistence.snapshotAgents(listAgents());
    }, 2000);
  }
}

export function spawnInteractive(profile: any, options: any = {}) {
  const agentId = crypto.randomUUID();
  const terminalId = options.terminalId || `zana-${agentId.slice(0, 8)}`;
  const cwd = options.cwd || profile.defaultCwd || process.env.HOME;

  const { command, args } = buildInteractiveCommand(profile, {
    name: `${profile.displayName} [${agentId.slice(0, 6)}]`,
    ...options,
  });

  // Spawn terminal first
  getPtyHost().spawnTerminal({
    terminalId,
    cwd,
    cols: options.cols || 120,
    rows: options.rows || 30,
  });

  const agent = {
    id: agentId,
    profileId: profile.id,
    profileName: profile.displayName,
    profileIcon: profile.icon || "🤖",
    terminalId,
    mode: "interactive",
    state: "spawning",
    model: profile.model || "default",
    pid: null,
    spawnedAt: Date.now(),
    lastActivity: Date.now(),
    toolsAllowed: profile.allowedTools?.length || null,
    toolsTotal: null,
    tokenCount: 0,
    lastAction: "Initializing...",
  };

  agents.set(agentId, agent);

  // Send the claude command to the PTY
  const fullCommand = `${command} ${args.map((a: string) => a.includes(" ") ? `"${a}"` : a).join(" ")}\n`;

  setTimeout(() => {
    getPtyHost().writeTerminal(terminalId, fullCommand);
    agent.state = "active";
    agent.lastAction = "Claude session started";
    agent.lastActivity = Date.now();
    notifyChange();
  }, 300);

  notifyChange();
  bus.emit(EVENTS.AGENT_SPAWNED, { agentId, profileId: profile.id, mode: "interactive" });

  return { agentId, terminalId };
}

export function updateAgentFromHook(payload: any) {
  const terminalId = payload.zana_terminal_id;
  if (!terminalId) return;

  const agent = Array.from(agents.values()).find(
    (a) => a.terminalId === terminalId,
  );
  if (!agent) return;

  agent.lastActivity = Date.now();

  const event = payload.hook_event_name;
  if (event === "PreToolUse" || event === "PostToolUse") {
    const toolName = payload.tool_name || payload.tool?.name || "unknown";
    agent.lastAction = `${event === "PreToolUse" ? "Running" : "Completed"}: ${toolName}`;
  } else if (event === "Stop") {
    agent.state = "idle";
    agent.lastAction = "Waiting for input...";
  } else if (event === "SessionStart") {
    agent.state = "active";
    agent.lastAction = "Session started";
  } else if (event === "SessionEnd") {
    agent.state = "terminated";
    agent.lastAction = "Session ended";
  }

  bus.emit(EVENTS.AGENT_HOOK, {
    agentId: agent.id,
    zana_terminal_id: terminalId,
    hook_event_name: event,
    tool_name: payload.tool_name || payload.tool?.name,
    tool_input: payload.tool_input,
    duration_ms: payload.duration_ms,
  });

  notifyChange();
}

export function killAgent(agentId: string) {
  const agent = agents.get(agentId);
  if (!agent) return false;

  if (agent.terminalId) {
    getPtyHost().killTerminal(agent.terminalId);
  }

  agent.state = "terminated";
  agent.lastAction = "Killed by user";
  notifyChange();
  bus.emit(EVENTS.AGENT_TERMINATED, { agentId, profileId: agent.profileId, reason: "killed" });

  setTimeout(() => {
    agents.delete(agentId);
    notifyChange();
  }, 3000);

  return true;
}

export function getAgent(agentId: string) {
  return agents.get(agentId) || null;
}

export function listAgents() {
  return Array.from(agents.values());
}

export function writeToAgent(agentId: string, jsonMessage: any) {
  const agent = agents.get(agentId);
  if (!agent?.childProcess?.stdin?.writable) return false;
  agent.childProcess.stdin.write(JSON.stringify(jsonMessage) + "\n");
  return true;
}

export function onAgentsChange(cb: (snapshot: any[]) => void) {
  changeListeners.push(cb);
  return () => {
    changeListeners = changeListeners.filter((l) => l !== cb);
  };
}

// emitTerminated — single source of truth for the AGENT_TERMINATED payload
// shape. Multiple consumers depend on this exact shape (work/tickets/watcher,
// scheduling/service, intelligence/goap-planner, background-workers,
// server/api/sse-broadcaster, events/stats-engine).
export function emitTerminated(
  agentId: string,
  profileId: string,
  reason: "completed" | "errored" | "spawn-error",
  extra: { exitCode?: number | null; output?: string | null; error?: string } = {}
) {
  bus.emit(EVENTS.AGENT_TERMINATED, { agentId, profileId, reason, ...extra });
}

// persistAgentRun — writes the terminated agent's record to
// <projectDir>/runs/<agentId>.json so it survives daemon restarts. Without
// this the schedule history's agentId pointer dangles after a restart.
// Errors are swallowed (warned) — persistence failure must never block
// termination dispatch.
export function persistAgentRun(agent: any, exitCode: number | null) {
  try {
    const fsMod = require("node:fs");
    const pathMod = require("node:path");
    const workspaceContext = require("../project/workspace-context");
    const runsDir = workspaceContext.getProjectPaths().runsDir;
    fsMod.mkdirSync(runsDir, { recursive: true });

    // Truncate runaway result text (e.g. an agent stuck in a loop) before serializing.
    const MAX_RESULT_BYTES = 100 * 1024;
    const { childProcess: _omit, ...serializable } = agent;
    const trimmedResult =
      typeof serializable.result === "string" && serializable.result.length > MAX_RESULT_BYTES
        ? serializable.result.slice(0, MAX_RESULT_BYTES) + `\n…[truncated ${serializable.result.length - MAX_RESULT_BYTES} chars]`
        : serializable.result;

    const record = {
      ...serializable,
      result: trimmedResult,
      terminatedAt: new Date().toISOString(),
      exitCode,
    };
    fsMod.writeFileSync(
      pathMod.join(runsDir, `${agent.id}.json`),
      JSON.stringify(record, null, 2),
      "utf8"
    );
  } catch (err: any) {
    console.warn(`[agent-manager] failed to persist run record for ${agent.id}: ${err?.message || err}`);
  }
}

/**
 * Spawn an agent in headless mode (one-shot, no PTY).
 * The agent record is stored internally and accessible via getAgent(agentId).
 */
export function spawnHeadlessAgent(profile: any, options: any = {}) {
  const agentId = crypto.randomUUID();
  const terminalId = options.terminalId || `zana-hl-${agentId.slice(0, 8)}`;
  const cwd = options.cwd || profile.defaultCwd || process.env.HOME;

  // 3-tier model routing: auto-select cheapest capable model
  const routedModel = selectModel(options.prompt, {
    category: profile.category,
    model: profile.model,
  });
  const routedProfile = profile.model ? profile : { ...profile, model: routedModel };

  const child = spawnHeadless(routedProfile, {
    name: `${profile.displayName} [${agentId.slice(0, 6)}]`,
    cwd,
    prompt: options.prompt,
    terminalId,
    profileId: profile.id,
    multiTurn: options.multiTurn || false,
  });

  const agent: any = {
    id: agentId,
    profileId: profile.id,
    profileName: profile.displayName,
    profileIcon: profile.icon || "🤖",
    terminalId,
    mode: "headless",
    state: "active",
    model: routedProfile.model || "default",
    pid: child.pid,
    spawnedAt: Date.now(),
    lastActivity: Date.now(),
    toolsAllowed: profile.allowedTools?.length || null,
    toolsTotal: null,
    tokenCount: 0,
    lastAction: "Running headless...",
    parentAgentId: options.parentAgentId || null,
    result: null,
  };

  agent.childProcess = child;

  agents.set(agentId, agent);
  notifyChange();
  bus.emit(EVENTS.AGENT_SPAWNED, { agentId, profileId: profile.id, mode: "headless" });

  let outputBuffer = "";
  // Expose raw stdout buffer on the agent record so probes (and other consumers)
  // can fall back to it when stream-json parsing fails to populate `result`.
  agent.outputBuffer = "";

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    outputBuffer += text;
    agent.outputBuffer = outputBuffer;
    agent.lastActivity = Date.now();

    // Parse stream-json lines for status
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant" && msg.message?.content) {
          const textBlocks = msg.message.content.filter((b: any) => b.type === "text");
          if (textBlocks.length > 0) {
            // Streaming chunks land on lastAssistantText so callers reading
            // `agent.result` see the FINAL result emitted on type:"result"
            // (or null if the stream tore before that). Prior code overwrote
            // agent.result here too, which made `result` mean "most recent
            // narration" — misled team_status during dogfooding.
            agent.lastAssistantText = textBlocks.map((b: any) => b.text).join("\n");
          }
        }
        if (msg.type === "result") {
          if (msg.result) agent.result = msg.result;
          if (msg.usage) {
            agent.tokensIn = msg.usage.input_tokens || 0;
            agent.tokensOut = msg.usage.output_tokens || 0;
            agent.tokensCacheRead = msg.usage.cache_read_input_tokens || 0;
            agent.tokensCacheWrite = msg.usage.cache_creation_input_tokens || 0;
          }
          if (typeof msg.total_cost_usd === "number") agent.costUsd = msg.total_cost_usd;
          if (typeof msg.duration_ms === "number") agent.durationMs = msg.duration_ms;
          if (typeof msg.num_turns === "number") agent.numTurns = msg.num_turns;
        }
      } catch (err) {
        // Non-JSON lines from stdout are normal (e.g. progress indicators)
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.includes("error") || text.includes("Error")) {
      agent.lastAction = `Error: ${text.slice(0, 80)}`;
    }
  });

  // Configurable timeout for headless agents
  const AGENT_TIMEOUT_MS = (moduleConfig.getModuleConfig("system")?.agentTimeoutMinutes || 10) * 60 * 1000;
  const timeoutHandle = setTimeout(() => {
    if (getAgent(agentId)?.state === "active") {
      console.warn(`[agent-manager] agent ${agentId} timed out after ${AGENT_TIMEOUT_MS / 60000}min, killing`);
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5000);
    }
  }, AGENT_TIMEOUT_MS);

  child.on("error", (err: any) => {
    clearTimeout(timeoutHandle);
    console.error(`[agent-manager] spawn error for ${agentId}:`, err.message);
    agent.state = "error";
    agent.lastAction = `Spawn error: ${err.message}`;
    notifyChange();
    emitTerminated(agentId, profile.id, "spawn-error", { error: err.message });
    const resilienceMod = require("../modules/loader").getModule?.("resilience");
    resilienceMod?.api?.recordFailure?.("agent-spawn");
  });

  child.on("close", (code: number) => {
    clearTimeout(timeoutHandle);
    agent.state = code === 0 ? "terminated" : "errored";
    agent.lastAction = code === 0 ? "Completed" : `Exited (code ${code})`;
    notifyChange();
    emitTerminated(agentId, profile.id, code === 0 ? "completed" : "errored", {
      exitCode: code,
      output: agent.result || null,
    });
    if (code === 0) {
      const resilienceMod = require("../modules/loader").getModule?.("resilience");
      resilienceMod?.api?.recordSuccess?.("agent-spawn");
    }
    persistAgentRun(agent, code);
  });

  return { agentId, terminalId };
}
