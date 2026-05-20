import { buildInteractiveCommand, spawnHeadless } from "./spawner";
import { selectModel } from "./model-router";
import { getProbeConfig } from "./probe-config";
import { lookupProbeResult, recordProbeResult } from "./probe-cache";
import * as crypto from "node:crypto";
import * as os from "node:os";

// Lazy-load pty-host only when interactive mode is needed (requires node-pty native module)
let _ptyHost = null;
function getPtyHost() {
  if (!_ptyHost) {
    try {
      _ptyHost = require("./pty-host");
    } catch (err) {
      throw new Error(
        `pty-host unavailable (node-pty not installed). Interactive mode requires node-pty. Error: ${err.message}`
      );
    }
  }
  return _ptyHost;
}
import * as profileStore from "./profile-store";
const skillStore: any = new Proxy({}, { get: (_t, p) => require("@zana/extras").settings.skillStore[p] });
const swarmPkg = require("@zana/swarm");
const swarmRouter = swarmPkg.router;
const swarmEvents = swarmPkg.events;
const swarmSpawner = swarmPkg.spawner;

// Lazy getters for cross-package modules — Node's require cache makes repeat calls cheap.
// Do NOT memoize into module-scope vars; that defeats the cycle break.
function _ticketService() { return require("@zana/work").tickets.service; }
function _ticketStore() { return require("@zana/work").tickets.store; }
function _schedulerService() { return require("@zana/work").scheduling.service; }
function _checkpointStore() { return require("@zana/work").runs.checkpoint.store; }
function _checkpointResume() { return require("@zana/work").runs.checkpoint.resume; }
function _artifactStore() { return require("@zana/work").runs.artifacts; }
import * as persistence from "../persistence";
import { bus, EVENTS } from "../events/bus";
import type { ProbeFailure, ProbeFailureKind, AgentProbedPayload } from "../events/deliberation-events";
import { MAX_CONCURRENT_AGENTS } from "../config";
import * as moduleConfig from "../modules/config";

function getMaxConcurrentAgents() {
  const cfg = moduleConfig.get();
  return Number(process.env.ZANA_MAX_WORKERS) || cfg?.system?.maxConcurrentAgents || MAX_CONCURRENT_AGENTS;
}

function checkSystemResources() {
  const cfg = moduleConfig.get()?.system;
  const cpuThreshold = cfg?.cpuLoadThreshold ?? 0.8;
  const minFreePct = cfg?.minFreeMemoryPct ?? 10;

  const load1m = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const maxLoad = cpuCount * cpuThreshold;
  if (load1m > maxLoad) {
    return `CPU load too high: ${load1m.toFixed(2)} exceeds threshold ${maxLoad.toFixed(2)} (${cpuCount} cores x ${(cpuThreshold * 100).toFixed(0)}%)`;
  }

  const freePct = (os.freemem() / os.totalmem()) * 100;
  if (freePct < minFreePct) {
    return `memory too low: ${freePct.toFixed(1)}% free, minimum is ${minFreePct}%`;
  }

  return null;
}

const agents = new Map();

let changeListeners = [];

let snapshotTimer = null;

function notifyChange() {
  const snapshot = listAgents();
  for (const cb of changeListeners) {
    try {
      cb(snapshot);
    } catch (err) {
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

export function spawnInteractive(profile, options = {}) {
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
  const fullCommand = `${command} ${args.map((a) => a.includes(" ") ? `"${a}"` : a).join(" ")}\n`;

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

export function updateAgentFromHook(payload) {
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

export function killAgent(agentId) {
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

export function getAgent(agentId) {
  return agents.get(agentId) || null;
}

export function listAgents() {
  return Array.from(agents.values());
}

export function writeToAgent(agentId, jsonMessage) {
  const agent = agents.get(agentId);
  if (!agent?.childProcess?.stdin?.writable) return false;
  agent.childProcess.stdin.write(JSON.stringify(jsonMessage) + "\n");
  return true;
}

export function onAgentsChange(cb) {
  changeListeners.push(cb);
  return () => {
    changeListeners = changeListeners.filter((l) => l !== cb);
  };
}

/**
 * Spawn an agent in headless mode (one-shot, no PTY).
 * The agent record is stored internally and accessible via getAgent(agentId).
 *
 * @param {Object} profile - Profile object (use profileStore.getProfile)
 * @param {Object} options
 * @param {string} options.prompt - Initial prompt for the agent
 * @param {string} [options.cwd] - Working directory (defaults to profile.defaultCwd or HOME)
 * @param {string} [options.terminalId] - Override terminal ID
 * @param {boolean} [options.multiTurn=false] - Enable multi-turn stream-json input
 * @returns {{ agentId: string, terminalId: string }} Agent identifier; query state via getAgent(agentId)
 */
export function spawnHeadlessAgent(profile, options = {}) {
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

  const agent = {
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
  (agent as any).outputBuffer = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    outputBuffer += text;
    (agent as any).outputBuffer = outputBuffer;
    agent.lastActivity = Date.now();

    // Parse stream-json lines for status
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant" && msg.message?.content) {
          const textBlocks = msg.message.content.filter((b) => b.type === "text");
          if (textBlocks.length > 0) {
            agent.result = textBlocks.map((b) => b.text).join("\n");
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

  child.stderr.on("data", (chunk) => {
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

  child.on("error", (err) => {
    clearTimeout(timeoutHandle);
    console.error(`[agent-manager] spawn error for ${agentId}:`, err.message);
    agent.state = "error";
    agent.lastAction = `Spawn error: ${err.message}`;
    notifyChange();
    bus.emit(EVENTS.AGENT_TERMINATED, { agentId, profileId: profile.id, reason: "spawn-error", error: err.message });
    const resilienceMod = require("../modules/loader").getModule?.("resilience");
    resilienceMod?.api?.recordFailure?.("agent-spawn");
  });

  child.on("close", (code) => {
    clearTimeout(timeoutHandle);
    agent.state = code === 0 ? "terminated" : "errored";
    agent.lastAction = code === 0 ? "Completed" : `Exited (code ${code})`;
    notifyChange();
    bus.emit(EVENTS.AGENT_TERMINATED, { agentId, profileId: profile.id, reason: code === 0 ? "completed" : "errored", exitCode: code, output: agent.result || null });
    if (code === 0) {
      const resilienceMod = require("../modules/loader").getModule?.("resilience");
      resilienceMod?.api?.recordSuccess?.("agent-spawn");
    }
    // Persist the terminated agent's record to <projectDir>/runs/<agentId>.json
    // so it survives daemon restarts. Without this, the schedule history's
    // agentId pointer dangles after a restart.
    try {
      const fsMod = require("node:fs");
      const pathMod = require("node:path");
      const workspaceContext = require("../project/workspace-context");
      const runsDir = workspaceContext.getProjectPaths().runsDir;
      fsMod.mkdirSync(runsDir, { recursive: true });

      // Truncate runaway result text (e.g. an agent stuck in a loop) before serializing.
      const MAX_RESULT_BYTES = 100 * 1024;
      const { childProcess: _omit, ...serializable } = agent as any;
      const trimmedResult =
        typeof serializable.result === "string" && serializable.result.length > MAX_RESULT_BYTES
          ? serializable.result.slice(0, MAX_RESULT_BYTES) + `\n…[truncated ${serializable.result.length - MAX_RESULT_BYTES} chars]`
          : serializable.result;

      const record = {
        ...serializable,
        result: trimmedResult,
        terminatedAt: new Date().toISOString(),
        exitCode: code,
      };
      fsMod.writeFileSync(
        pathMod.join(runsDir, `${agentId}.json`),
        JSON.stringify(record, null, 2),
        "utf8"
      );
    } catch (err: any) {
      console.warn(`[agent-manager] failed to persist run record for ${agentId}: ${err?.message || err}`);
    }
  });

  return { agentId, terminalId };
}

// ---------------------------------------------------------------------------
// probeAgent — capability probe (T3, deliberation/quorum gate)
//
// Validates a profile is *functionally* ready before adding it to a council.
// Deliberately NOT a shallow PONG ping: we exercise factual recall, real
// instruction-following, and (when the profile permits) tool use. Each leg
// spawns a short-lived headless agent in parallel; the probe passes only if
// all applicable legs pass within the timeout.
//
// Probes always run on the profile's declared model; we bypass cost-routing
// (selectModel) so audit attribution is correct. Profiles with no declared
// model are a real misconfiguration and the probe reports `ok: false`.
//
// Tests inject fake deps via the `deps` parameter. The pattern matches
// spawnValidatedAgent (manager.ts:611) and checkpointResume (:911).
// ---------------------------------------------------------------------------

export interface ProbeRequest {
  factual?: string;
  instructionFollowing?: string;
  toolUse?: string;
  timeoutMs?: number;
}

export interface ProbeLegResult {
  leg: string;
  ok: boolean;
  // Typed failure per FU-T3a — top-level failures[] is just legs.flatMap(l => l.failure ? [l.failure] : []) plus any whole-probe entries.
  failure?: ProbeFailure;
  latencyMs: number;
  modelId: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  failures: ProbeFailure[];   // typed (FU-T3a)
  modelId: string;
  probeId: string;
  legs: ProbeLegResult[];
  // T6-FU-2 — true when this result was returned from the (profileId, modelId)
  // cache rather than a fresh probe. Absent / false on a real probe. Audit
  // consumers use this to know latencyMs reflects the original probe, not the
  // cache lookup.
  cached?: boolean;
}

// Re-export ProbeFailure types so consumers can import from agents/manager.
export type { ProbeFailure, ProbeFailureKind } from "../events/deliberation-events";

// FU-T3a-3 — classify a spawn-path error message into a typed retry-policy
// bucket. T9 will key retry policy off this: transient (timeout/rate_limit/
// transport) get retried with backoff; structural (auth/quota/misconfig)
// escalate. Heuristic on err.message + err.code — real-world error shapes
// vary, so we match on common substrings rather than exact codes. Anything
// unrecognized falls through to "spawn" (legacy bucket) so the contract is
// strictly additive: no message previously bucketed as "spawn" will
// silently retarget unless it actually matches a more-specific pattern.
//
// Caveat for callers: the heuristics are intentionally generous (e.g.
// "401" matches but so does "/v1/401-handler" — false-positive risk).
// Real-world error shapes vary widely across SDKs; if T9 finds the
// classifier mis-buckets a real failure, tighten the regex here. Exported
// for unit testing.
export function classifySpawnError(err: unknown): ProbeFailureKind {
  const msg = (() => {
    if (err == null) return "";
    if (typeof err === "string") return err;
    if (typeof err === "object") {
      const anyErr = err as any;
      const parts: string[] = [];
      if (typeof anyErr.code === "string") parts.push(anyErr.code);
      if (typeof anyErr.message === "string") parts.push(anyErr.message);
      if (parts.length === 0) parts.push(String(err));
      return parts.join(" ");
    }
    return String(err);
  })();
  if (!msg) return "spawn";

  // Order matters: match the most specific buckets first. Auth before
  // transport so "TLS 401 cert error" buckets to auth (the gateway rejected
  // creds), not transport.
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid[\s._-]*token/i.test(msg)) {
    return "auth";
  }
  if (/\b429\b|rate[\s._-]*limit|too[\s._-]*many[\s._-]*requests?/i.test(msg)) {
    return "rate_limit";
  }
  if (/\b402\b|payment[\s._-]*required|quota|exhausted|usage[\s._-]*limit/i.test(msg)) {
    return "quota";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS|certificate|SSL/i.test(msg)) {
    return "transport";
  }
  // Process-level: ENOENT (binary not found), EACCES (perm-denied on binary).
  // Fall through to "spawn" anyway so the legacy bucket holds the line.
  return "spawn";
}

// Truncate raw output captured for debugging. Bound is config-driven via
// probe-config (default 1024); tests can override with setProbeConfig().
function _truncateRaw(s: string | null | undefined): string | undefined {
  if (typeof s !== "string" || s.length === 0) return undefined;
  const max = (() => {
    const v = getProbeConfig().probeRawMaxBytes;
    return typeof v === "number" && v > 0 ? Math.floor(v) : 1024;
  })();
  return s.length > max ? s.slice(0, max) : s;
}

export interface ProbeDeps {
  spawnHeadlessAgent?: typeof spawnHeadlessAgent;
  getAgent?: typeof getAgent;
  killAgent?: typeof killAgent;
  // T6-FU-2 — override probe-config.probeCacheTtlMs for this call only.
  // 0 disables caching; undefined falls back to probe-config.
  probeCacheTtlMs?: number;
}

const DEFAULT_PROBE_FACTUAL = "Reply with exactly the number 42.";
// Real instruction-following check: requires emitting a specific token.
// Empty / non-empty alone proves nothing — that's PONG theatre.
const DEFAULT_PROBE_INSTRUCTION_FOLLOWING =
  "Reply with exactly the token PROBE_REFUSAL_OK and nothing else.";
const DEFAULT_PROBE_TOOL_USE = "Use Bash to run `echo PROBE_OK` and reply with the stdout literally.";
// Fallback if probe-config is unreachable. probe-config.getProbeConfig() defaults
// to this same value — keeping the const documents the wire-in target.
const DEFAULT_PROBE_TIMEOUT_MS_FALLBACK = 30000;

function _probePollResult(
  agentId: string,
  deadline: number,
  get: typeof getAgent,
): Promise<{ state: string; result: string | null; outputBuffer: string | null }> {
  return new Promise((resolve) => {
    const tick = () => {
      const ag = get(agentId);
      if (!ag) {
        resolve({ state: "missing", result: null, outputBuffer: null });
        return;
      }
      const terminal = ag.state === "terminated" || ag.state === "errored" || ag.state === "error";
      const buf = typeof (ag as any).outputBuffer === "string" ? (ag as any).outputBuffer : null;
      if (terminal) {
        resolve({
          state: ag.state,
          result: typeof ag.result === "string" ? ag.result : null,
          outputBuffer: buf,
        });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({
          state: "timeout",
          result: typeof ag.result === "string" ? ag.result : null,
          outputBuffer: buf,
        });
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function _runProbeLeg(
  legName: "factual" | "instructionFollowing" | "toolUse",
  profile: any,
  prompt: string,
  timeoutMs: number,
  validate: (output: string | null) => string | null, // returns failure reason or null on success
  deps: Required<ProbeDeps>,
): Promise<ProbeLegResult> {
  const started = Date.now();
  const deadline = started + timeoutMs;

  let agentId: string | null = null;
  let modelId = profile.model || "default";
  try {
    const { agentId: id } = deps.spawnHeadlessAgent(profile, { prompt });
    agentId = id;
  } catch (err: any) {
    const failure: ProbeFailure = {
      leg: legName,
      // FU-T3a-3 — classify auth/rate_limit/quota/transport vs legacy "spawn".
      kind: classifySpawnError(err),
      reason: `spawn error: ${err?.message || String(err)}`,
    };
    return { leg: legName, ok: false, failure, latencyMs: Date.now() - started, modelId };
  }

  const { state, result, outputBuffer } = await _probePollResult(agentId!, deadline, deps.getAgent);
  const latencyMs = Date.now() - started;

  const ag = deps.getAgent(agentId!);
  if (ag?.model) modelId = ag.model;

  if (state === "timeout") {
    // Use killAgent to clean up the agents Map and clear the AGENT_TIMEOUT_MS
    // setTimeout owned by spawnHeadlessAgent. A bare child.kill() leaks both.
    try { deps.killAgent(agentId!); } catch {}
    const failure: ProbeFailure = {
      leg: legName,
      kind: "timeout",
      reason: `leg timed out after ${timeoutMs}ms`,
    };
    return { leg: legName, ok: false, failure, latencyMs, modelId };
  }

  if (state === "errored" || state === "error" || state === "missing") {
    // FU-T3a-3 — classify by the agent's lastAction text (which carries the
    // upstream error message from the spawner's error handler). Falls back
    // to "spawn" (legacy bucket) when no message is recoverable.
    const errMsg = typeof ag?.lastAction === "string" ? ag.lastAction : "";
    const failure: ProbeFailure = {
      leg: legName,
      kind: classifySpawnError(errMsg || `agent ${state}`),
      reason: `agent ${state}${errMsg ? `: ${errMsg}` : ""}`,
    };
    return { leg: legName, ok: false, failure, latencyMs, modelId };
  }

  // Stream-json parsing can fail to populate `agent.result` when shape varies.
  // Fall back to the raw stdout buffer before declaring failure — the spawner
  // exposes it as `agent.outputBuffer`.
  const candidate = result && result.length > 0 ? result : outputBuffer;
  const validationReason = validate(candidate);
  if (validationReason) {
    const failure: ProbeFailure = {
      leg: legName,
      kind: "validation",
      reason: validationReason,
      raw: _truncateRaw(candidate),
    };
    return { leg: legName, ok: false, failure, latencyMs, modelId };
  }
  return { leg: legName, ok: true, latencyMs, modelId };
}

export async function probeAgent(
  profile: any,
  probe?: ProbeRequest,
  deps?: ProbeDeps,
): Promise<ProbeResult> {
  const probeId = crypto.randomUUID();
  const resolved = {
    spawnHeadlessAgent: deps?.spawnHeadlessAgent ?? spawnHeadlessAgent,
    getAgent: deps?.getAgent ?? getAgent,
    killAgent: deps?.killAgent ?? killAgent,
  } as Required<Pick<ProbeDeps, "spawnHeadlessAgent" | "getAgent" | "killAgent">>;

  // No declared model = real misconfiguration; bypass-routing means we have
  // no fallback and audit attribution would be meaningless either way.
  const declaredModel: string | null =
    typeof profile?.model === "string" && profile.model.length > 0 ? profile.model : null;
  if (!declaredModel) {
    const misconfig: ProbeFailure = {
      leg: null,
      kind: "misconfig",
      reason: "profile has no declared model",
    };
    const result: ProbeResult = {
      ok: false,
      latencyMs: 0,
      failures: [misconfig],
      modelId: "unknown",
      probeId,
      legs: [],
      cached: false,
    };
    _emitAgentProbed(profile, result);
    return result;
  }

  // T6-FU-2 — consult cache before spawning. Key by (profileId, modelId);
  // skip when no profileId is available (anonymous profiles can't be cached
  // safely — they may differ leg-by-leg).
  const ttlMs: number = (() => {
    if (typeof deps?.probeCacheTtlMs === "number") return deps.probeCacheTtlMs;
    const v = getProbeConfig().probeCacheTtlMs;
    return typeof v === "number" && v >= 0 ? v : 0;
  })();
  const profileId: string | null =
    typeof profile?.id === "string" && profile.id.length > 0 ? profile.id : null;
  const cacheKey = profileId ? `${profileId}:${declaredModel}` : null;

  if (ttlMs > 0 && cacheKey) {
    const cached = lookupProbeResult(cacheKey, ttlMs);
    if (cached) {
      // Mint a fresh probeId so audit can distinguish lookups from real
      // probes. Re-emit AGENT_PROBED so the audit chain still records the
      // attempt with cached:true (caller knows latency is stale).
      const hit: ProbeResult = { ...cached, probeId, cached: true };
      _emitAgentProbed(profile, hit);
      return hit;
    }
  }

  const configuredTimeoutMs = (() => {
    const v = getProbeConfig().probeTimeoutMs;
    return typeof v === "number" && v > 0 ? Math.floor(v) : DEFAULT_PROBE_TIMEOUT_MS_FALLBACK;
  })();
  const timeoutMs = probe?.timeoutMs ?? configuredTimeoutMs;
  const factualPrompt = probe?.factual ?? DEFAULT_PROBE_FACTUAL;
  const instructionPrompt = probe?.instructionFollowing ?? DEFAULT_PROBE_INSTRUCTION_FOLLOWING;
  const toolUsePrompt = probe?.toolUse ?? DEFAULT_PROBE_TOOL_USE;

  const allowedTools: string[] = Array.isArray(profile?.allowedTools) ? profile.allowedTools : [];
  const canUseBash = allowedTools.includes("Bash");

  // Bypass selectModel: pass a profile clone with `model` already set so the
  // routing pass-through in spawnHeadlessAgent is a no-op.
  const probeProfile = { ...profile, model: declaredModel };

  const legs: Promise<ProbeLegResult>[] = [];

  legs.push(
    _runProbeLeg("factual", probeProfile, factualPrompt, timeoutMs, (out) => {
      if (!out || !out.includes("42")) return "response missing '42'";
      return null;
    }, resolved)
  );

  legs.push(
    _runProbeLeg("instructionFollowing", probeProfile, instructionPrompt, timeoutMs, (out) => {
      if (!out || !out.includes("PROBE_REFUSAL_OK")) {
        return "response missing required token 'PROBE_REFUSAL_OK' (instruction not followed)";
      }
      return null;
    }, resolved)
  );

  if (canUseBash) {
    legs.push(
      _runProbeLeg("toolUse", probeProfile, toolUsePrompt, timeoutMs, (out) => {
        if (!out || !out.includes("PROBE_OK")) return "response missing 'PROBE_OK' (tool likely not invoked)";
        return null;
      }, resolved)
    );
  }

  const results = await Promise.all(legs);

  const failures: ProbeFailure[] = [];
  let maxLatency = 0;
  for (const r of results) {
    if (!r.ok && r.failure) failures.push(r.failure);
    if (r.latencyMs > maxLatency) maxLatency = r.latencyMs;
  }

  // Aggregate modelId deterministically from the profile's declared model.
  // Per-leg modelIds are surfaced in `legs[]` for the rare divergence case.
  const result: ProbeResult = {
    ok: failures.length === 0,
    latencyMs: maxLatency,
    failures,
    modelId: declaredModel,
    probeId,
    legs: results,
    cached: false,
  };

  // T6-FU-2 — store the result if caching is enabled AND the failure mix is
  // not transient. Transient failures (timeout/rate_limit/transport/quota)
  // can self-heal on the next call, so caching them would prolong an outage.
  // Structural failures (auth/misconfig) plus legacy buckets (validation/
  // spawn) are stable enough to cache — and caching them prevents 9N spawns
  // per round for a misbehaving voter.
  if (ttlMs > 0 && cacheKey) {
    if (_shouldCacheProbeResult(result)) {
      recordProbeResult(cacheKey, result);
    }
  }

  _emitAgentProbed(profile, result);
  return result;
}

// Per FU-T2 caching rules. Returns true when this result is safe to memoize.
// Successful probes always cache. Failures cache only when EVERY kind is a
// known-stable bucket: auth | misconfig | validation. Transient kinds
// (timeout | rate_limit | transport | quota) explicitly skip cache so the next
// call can retry. The legacy "spawn" bucket is ALSO skipped: classifySpawnError
// falls through to "spawn" for anything it can't classify, and the
// agent.lastAction read in _runProbeLeg's errored branch is truncated to 80
// chars (FU-S26-b) — a clipped 429/ECONNRESET would be misclassified "spawn"
// and poison the cache for 5 min. Once FU-S26-b plumbs structured errors,
// "spawn" can be re-added to the cache-eligible set.
function _shouldCacheProbeResult(result: ProbeResult): boolean {
  if (result.ok) return true;
  for (const f of result.failures) {
    if (f.kind !== "auth" && f.kind !== "misconfig" && f.kind !== "validation") {
      return false;
    }
  }
  return true;
}

// Emit agent:probed for audit attribution (FU-T3b). Fired exactly once per
// probeAgent call — including the whole-probe misconfig short-circuit — so
// the event stream is the source of truth for "which probes ran, when".
function _emitAgentProbed(profile: any, result: ProbeResult): void {
  const payload: AgentProbedPayload = {
    probeId: result.probeId,
    profileId: profile?.id ?? "unknown",
    modelId: result.modelId,
    ok: result.ok,
    failures: result.failures,
    latencyMs: result.latencyMs,
    ts: new Date().toISOString(),
    // T6-FU-2 — explicit boolean so audit consumers don't have to distinguish
    // missing-field vs false. Real probes set cached:false on the result;
    // cache-hit branch sets cached:true.
    cached: result.cached === true,
  };
  bus.emit(EVENTS.AGENT_PROBED, payload);
}

export async function handleOrchestratorCommand(payload, getWorkspaceFn) {
  const { action, ...params } = payload;

  switch (action) {
    case "spawn_agent": {
      const resilienceMod = require("../modules/loader").getModule?.("resilience");
      if (resilienceMod?.api?.isOpen?.("agent-spawn")) {
        return { error: "Circuit breaker open: too many recent spawn failures. Try again later." };
      }
      const resourceError = checkSystemResources();
      if (resourceError) {
        return { error: `system overloaded: ${resourceError}` };
      }
      const { profileId, prompt, parentAgentId } = params;
      if (parentAgentId) {
        const allAgents = listAgents();
        const childCount = allAgents.filter(a => a.parentAgentId === parentAgentId && a.state !== "terminated").length;
        const maxWorkers = getMaxConcurrentAgents();
        if (childCount >= maxWorkers) {
          return { error: `max concurrent workers reached (${maxWorkers}). Wait for existing workers to complete.` };
        }
      }
      const profile = profileStore.getProfile(profileId);
      if (!profile) return { error: `profile not found: ${profileId}` };
      const cwd = getWorkspaceFn ? getWorkspaceFn() : process.env.HOME;
      const result = spawnHeadlessAgent(profile, { prompt, cwd, parentAgentId });
      return { agentId: result.agentId, status: "spawned" };
    }
    case "spawn_agent_validated": {
      const { profileId, prompt, parentAgentId, guardrails: guardrailConfigs, maxRetries } = params;
      if (parentAgentId) {
        const allAgents = listAgents();
        const childCount = allAgents.filter(a => a.parentAgentId === parentAgentId && a.state !== "terminated").length;
        const maxWorkers = getMaxConcurrentAgents();
        if (childCount >= maxWorkers) {
          return { error: `max concurrent workers reached (${maxWorkers}). Wait for existing workers to complete.` };
        }
      }
      const profile = profileStore.getProfile(profileId);
      if (!profile) return { error: `profile not found: ${profileId}` };
      const cwd = getWorkspaceFn ? getWorkspaceFn() : process.env.HOME;
      const guardrails = require("../guardrails/index");
      const result = await guardrails.spawnValidatedAgent(
        { spawnHeadlessAgent, getAgent },
        profile,
        { prompt, cwd, parentAgentId, maxRetries },
        guardrailConfigs || []
      );
      return {
        agentId: result.agentId,
        status: result.guardrailsPassed ? "completed" : "validation_failed",
        attempts: result.attempts,
        guardrailsPassed: result.guardrailsPassed,
        output: result.output,
        parsedOutput: result.parsedOutput || null,
        error: result.error || null,
      };
    }
    case "list_agents": {
      return listAgents().map((a) => ({
        id: a.id,
        profile: a.profileName,
        state: a.state,
        lastAction: a.lastAction,
        mode: a.mode,
      }));
    }
    case "agent_status": {
      const agent = getAgent(params.agentId);
      if (!agent) return { error: "agent not found" };
      return {
        id: agent.id,
        state: agent.state,
        lastAction: agent.lastAction,
        mode: agent.mode,
        uptime: Date.now() - agent.spawnedAt,
      };
    }
    case "agent_result": {
      const agent = getAgent(params.agentId);
      if (!agent) return { error: "agent not found" };
      return {
        id: agent.id,
        completed: agent.state === "terminated",
        result: agent.result || null,
        state: agent.state,
      };
    }
    case "kill_agent": {
      return { ok: killAgent(params.agentId) };
    }
    case "list_profiles": {
      return profileStore.listProfiles().map((p) => ({
        id: p.id,
        name: p.displayName,
        icon: p.icon,
        category: p.category,
        description: p.description,
        model: p.model,
      }));
    }
    case "get_profile": {
      const profile = profileStore.getProfile(params.profileId);
      if (!profile) return { error: `profile not found: ${params.profileId}` };
      return profile;
    }
    case "save_profile": {
      const saved = profileStore.saveProfile(params.profile);
      return { ok: true, id: saved.id, displayName: saved.displayName };
    }
    case "delete_profile": {
      const ok = profileStore.deleteProfile(params.profileId);
      return { ok };
    }
    case "list_skills": {
      return skillStore.listSkills();
    }
    case "get_skill": {
      const skill = skillStore.getSkill(params.skillId);
      if (!skill) return { error: `skill not found: ${params.skillId}` };
      return skill;
    }
    case "save_skill": {
      const saved = skillStore.saveSkill(params.skill);
      return { ok: true, id: saved.id, name: saved.name };
    }
    case "delete_skill": {
      const ok = skillStore.deleteSkill(params.skillId);
      return { ok };
    }
    case "toggle_skill": {
      const ok = skillStore.toggleSkill(params.skillId, params.enabled);
      return { ok };
    }

    // --- Ticketing ---
    case "ticket_create": {
      return _ticketService().createTicket(params);
    }
    case "ticket_list": {
      return _ticketService().listTickets(params);
    }
    case "ticket_get": {
      return _ticketService().getTicket(params.ticketId);
    }
    case "ticket_claim": {
      return _ticketService().claimTicket(params.ticketId, params.agentId, params.agentName, params.profileId);
    }
    case "ticket_update_status": {
      return _ticketService().updateStatus(params.ticketId, params.status, params.updatedBy);
    }
    case "ticket_comment": {
      return _ticketService().addComment(params.ticketId, params.authorId, params.authorName, params.body);
    }
    case "ticket_complete": {
      return _ticketService().completeTicket(params.ticketId, params.resultSummary, params.completedBy);
    }
    case "ticket_edit": {
      const { ticketId, updatedBy, ...fields } = params;
      // Remove undefined values
      const cleanFields = Object.fromEntries(
        Object.entries(fields).filter(([_, v]) => v !== undefined)
      );
      return _ticketService().updateTicket(ticketId, cleanFields, updatedBy);
    }
    case "ticket_add_to_sprint": {
      return _ticketService().addTicketToSprint(params.ticketId, params.sprintId);
    }
    case "ticket_update": {
      const ticketService = _ticketService();
      const ticketStore = _ticketStore();
      const fs = require("node:fs");
      const path = require("node:path");
      const workspaceContext = require("../project/workspace-context");

      const ticket = ticketService.getTicket(params.ticketId);
      if (!ticket) return { error: "ticket not found" };

      const ticketsDir = workspaceContext.getProjectPaths().ticketsDir;
      const ticketDir = path.join(ticketsDir, params.ticketId);
      fs.mkdirSync(ticketDir, { recursive: true });

      if (params.progress) {
        ticketService.addComment(params.ticketId, params.agentId || "worker", params.agentName || "Worker", params.progress);
      }

      if (params.planification) {
        fs.writeFileSync(path.join(ticketDir, "plan.md"), params.planification, "utf8");
      }

      if (params.filesChanged && params.filesChanged.length > 0) {
        const existingFiles = [];
        try { existingFiles.push(...JSON.parse(fs.readFileSync(path.join(ticketDir, "files-changed.json"), "utf8"))); } catch {}
        const merged = [...new Set([...existingFiles, ...params.filesChanged])];
        fs.writeFileSync(path.join(ticketDir, "files-changed.json"), JSON.stringify(merged, null, 2), "utf8");
      }

      if (params.resultSummary) {
        fs.writeFileSync(path.join(ticketDir, "result.md"), params.resultSummary, "utf8");
      }

      if (params.reviewPhase) {
        ticketService.updateReviewPhase(params.ticketId, params.reviewPhase, params.agentId || "reviewer");
      }

      if (params.status) {
        if (params.status === "done" && params.resultSummary) {
          return ticketService.completeTicket(params.ticketId, params.resultSummary, params.agentId || "worker");
        } else {
          return ticketService.updateStatus(params.ticketId, params.status, params.agentId || "worker");
        }
      }

      ticket.updatedAt = new Date().toISOString();
      ticketStore.saveTicket(ticket);
      return { ok: true, ticketId: params.ticketId };
    }
    case "sprint_list": {
      return _ticketService().listSprints(params);
    }
    case "sprint_board": {
      return _ticketService().getSprintBoard(params.sprintId);
    }
    case "sprint_create": {
      return _ticketService().createSprint(params);
    }
    case "sprint_start": {
      return _ticketService().startSprint(params.sprintId);
    }
    case "sprint_end": {
      return _ticketService().endSprint(params.sprintId);
    }

    // --- Teams ---
    case "list_teams": {
      return require("@zana/work").teams.store.listTeams();
    }
    case "get_team": {
      const team = require("@zana/work").teams.store.getTeam(params.teamId);
      if (!team) return { error: `team not found: ${params.teamId}` };
      return team;
    }
    case "start_team": {
      const teamMod = require("@zana/work").teams.manager;
      const cwd = params.cwd || (getWorkspaceFn ? getWorkspaceFn() : process.env.HOME);
      return teamMod.startTeam(params.teamId, { prompt: params.prompt, cwd, headless: true });
    }
    case "stop_team": {
      return require("@zana/work").teams.manager.stopTeam(params.teamId);
    }
    case "team_status": {
      const status = require("@zana/work").teams.manager.getTeamStatus(params.teamId);
      if (!status) return { error: `team not running: ${params.teamId}` };
      return status;
    }
    case "list_running_teams": {
      return require("@zana/work").teams.manager.listRunningTeams();
    }

    // --- Artifacts ---
    case "artifact_create": {
      return _artifactStore().createArtifact(params);
    }
    case "artifact_list": {
      return _artifactStore().listArtifacts(params);
    }
    case "artifact_read": {
      const artifact = _artifactStore().getArtifact(params.artifactId);
      if (!artifact) return { error: `artifact not found: ${params.artifactId}` };
      return artifact;
    }
    case "artifact_update": {
      const { artifactId, ...fields } = params;
      const updated = _artifactStore().updateArtifact(artifactId, fields);
      if (!updated) return { error: `artifact not found: ${artifactId}` };
      return updated;
    }
    case "artifact_delete": {
      return { ok: _artifactStore().deleteArtifact(params.artifactId) };
    }

    // --- Scheduler ---
    case "schedule_create": {
      return _schedulerService().createSchedule(params);
    }
    case "schedule_list": {
      return _schedulerService().listSchedules();
    }
    case "schedule_get": {
      const schedulerService = _schedulerService();
      const schedule = schedulerService.getSchedule(params.scheduleId);
      const history = schedulerService.getRunHistory(params.scheduleId);
      return { schedule, history };
    }
    case "schedule_update": {
      const { id, ...fields } = params;
      return _schedulerService().updateSchedule(id, fields);
    }
    case "schedule_delete": {
      return { ok: _schedulerService().deleteSchedule(params.id) };
    }
    case "schedule_enable": {
      return _schedulerService().enableSchedule(params.id);
    }
    case "schedule_disable": {
      return _schedulerService().disableSchedule(params.id);
    }
    case "schedule_trigger": {
      return _schedulerService().triggerSchedule(params.id);
    }
    case "schedule_reload": {
      return _schedulerService().loadFromDisk();
    }

    // --- Event Bus ---
    case "event_emit": {
      const eventBusService = require("../events/service");
      eventBusService.emit(params.type, params.payload, params.tags);
      return { ok: true };
    }
    case "event_query": {
      const eventBusService = require("../events/service");
      const filter = {};
      if (params.types) filter.types = params.types;
      if (params.source) filter.source = params.source;
      if (params.since) filter.since = params.since;
      return eventBusService.query(filter, params.limit || 50);
    }

    // --- Checkpoint ---
    case "checkpoint_save": {
      const cp = _checkpointStore().save(params);
      return { ok: true, checkpointId: cp.id };
    }
    case "checkpoint_list": {
      return _checkpointStore().list(params);
    }
    case "checkpoint_get": {
      const cp = _checkpointStore().load(params.checkpointId);
      if (!cp) return { error: "checkpoint not found" };
      return cp;
    }
    case "checkpoint_resume": {
      return await _checkpointResume().resume(params.checkpointId, { spawnHeadlessAgent, getAgent }, profileStore);
    }

    // --- Swarm P2P ---
    case "discover_agents": {
      const localAgents = listAgents();
      const subDaemonPorts = swarmSpawner.getSubDaemonPorts();
      const all = await swarmRouter.refreshRoutingTable(localAgents, subDaemonPorts);
      if (params.query) {
        return swarmRouter.discoverAgents(params.query);
      }
      return all;
    }
    case "ask_agent": {
      const msg = {
        fromAgentId: params.fromAgentId || params.fromTerminalId || "unknown",
        fromDaemonId: process.env.ZANA_ID || "local",
        fromAgentName: params.fromAgentName || "Agent",
        toAgentId: params.toAgentId,
        type: "question",
        body: params.question,
        replyTo: params.replyTo || undefined,
      };
      const localAgents = listAgents();
      const subDaemonPorts = swarmSpawner.getSubDaemonPorts();
      return await swarmRouter.routeMessage(msg, localAgents, subDaemonPorts);
    }
    case "check_inbox": {
      const agentId = params.agentId || params.terminalId;
      return swarmRouter.drainInbox(agentId);
    }

    // --- Typed messaging + channels ---
    case "send_message": {
      const msg = {
        id: swarmRouter.generateMessageId(),
        sentAt: Date.now(),
        fromAgentId: params.fromAgentId,
        fromDaemonId: process.env.ZANA_ID || "local",
        fromAgentName: params.fromAgentName || "Agent",
        toAgentId: params.toAgentId,
        type: params.type,
        payload: params.payload,
        priority: params.priority || "normal",
        replyTo: params.replyTo || undefined,
        requiresAck: params.requiresAck || false,
      };
      if (msg.requiresAck) swarmRouter.requestAck(msg.id);
      const subDaemonPorts = swarmSpawner.listSubDaemons()
        .filter((h) => h.status === "running" && h.port)
        .map((h) => h.port);
      const result = await swarmRouter.routeMessage(msg, listAgents(), subDaemonPorts);
      return { ...result, messageId: msg.id };
    }
    case "publish_channel": {
      const msg = {
        fromAgentId: params.fromAgentId,
        fromDaemonId: process.env.ZANA_ID || "local",
        fromAgentName: params.fromAgentName || "Agent",
        type: params.type,
        payload: params.payload,
      };
      return swarmRouter.publishToChannel(params.channel, msg);
    }
    case "subscribe_channel": {
      return swarmRouter.subscribeChannel(params.channel, params.agentId);
    }
    case "list_channels": {
      return swarmRouter.listChannels();
    }
    case "channel_history": {
      return swarmRouter.getChannelHistory(params.channel, { limit: params.limit });
    }
    case "send_ack": {
      return swarmRouter.sendAck(params.messageId, params.agentId, params.status, params.response);
    }

    // --- Swarm (multi-daemon coordination) ---
    case "swarm_spawn": {
      const masterPort = process.env.ZANA_HOOK_PORT || "47400";
      const result = swarmSpawner.spawnSubDaemon({
        teamId: params.teamId,
        workspace: params.workspace || getWorkspaceFn(),
        prompt: params.prompt,
        masterPort,
        masterDaemonId: process.env.ZANA_ID || "master",
      });
      return result;
    }
    case "swarm_list": {
      return swarmSpawner.listSubDaemons();
    }
    case "swarm_instruct": {
      return await swarmSpawner.instructSubDaemon(params.daemonId, params.message);
    }
    case "swarm_stop": {
      return swarmSpawner.stopSubDaemon(params.daemonId);
    }
    case "swarm_broadcast": {
      const daemons = swarmSpawner.listSubDaemons().filter((h) => h.status === "running");
      const results = [];
      for (const h of daemons) {
        const r = await swarmSpawner.instructSubDaemon(h.daemonId || h.daemonId, params.message);
        results.push({ daemonId: h.daemonId || h.daemonId, ...r });
      }
      return { ok: true, results };
    }
    case "swarm_poll_events": {
      return swarmEvents.pending(params.since || 0);
    }

    case "spawn_oneshot": {
      const { spawnOneShot } = require("./spawner");
      const { profileId, prompt } = params;
      const profile = profileStore.getProfile(profileId);
      if (!profile) return { error: `profile not found: ${profileId}` };
      const cwd = getWorkspaceFn ? getWorkspaceFn() : process.env.HOME;
      const result = await spawnOneShot(profile, prompt, { cwd, timeout: params.timeout });
      return { output: result.output, exitCode: result.exitCode };
    }

    default:
      return { error: `unknown action: ${action}` };
  }
}

