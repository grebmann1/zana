// Agent lifecycle: spawn (interactive + headless), kill, status, change-listeners,
// probe-overload state, and load-gate.
//
// Module-level state lives here (the agents Map, changeListeners, snapshotTimer,
// spawnOverloadStreaks) and is the single source of truth shared across the
// other agents/* split modules (dispatch, team-runtime, probe-agent). The thin
// manager.ts facade re-exports the public surface from this file.

import { buildInteractiveCommand, spawnHeadless } from "./spawner";
import { selectModel } from "./model-router";
import { classifySpawnError, isTransientFailure } from "./error-classifier";
import type { ProbeFailureKind } from "./error-classifier";
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

// ── Transient-error retry policy ────────────────────────────────────────────
// A headless worker that exits nonzero from a TRANSIENT failure (rate-limit /
// 529 overload / network blip) is re-spawned with `--resume <sessionId>` after
// a backoff, preserving its conversation. Structural failures (auth/quota/
// misconfig) and exhausted attempts terminate as before. Mirrors the resilience
// behavior in claude-unleashed's daemon (parks → backoff → `claude --resume`).
//
// Defaults: 3 attempts, 30s / 2m / 8m backoff. Tunable via system config.
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = [30_000, 120_000, 480_000];

export function getTransientRetryMaxAttempts(): number {
  const cfg = moduleConfig.get()?.system;
  const v = cfg?.transientRetryMaxAttempts;
  return typeof v === "number" && v >= 0 ? v : DEFAULT_RETRY_MAX_ATTEMPTS;
}

export function getTransientRetryBackoffMs(attempt: number): number {
  const cfg = moduleConfig.get()?.system;
  const ladder = Array.isArray(cfg?.transientRetryBackoffMs) && cfg.transientRetryBackoffMs.length > 0
    ? cfg.transientRetryBackoffMs
    : DEFAULT_RETRY_BACKOFF_MS;
  // Clamp to the last rung for attempts beyond the ladder length.
  const idx = Math.min(attempt, ladder.length - 1);
  const ms = ladder[idx];
  return typeof ms === "number" && ms >= 0 ? ms : DEFAULT_RETRY_BACKOFF_MS[DEFAULT_RETRY_BACKOFF_MS.length - 1];
}

// Test seam: the backoff timer. Overridable so unit tests can fire the retry
// synchronously instead of waiting 30s. Defaults to real setTimeout.
let _retryScheduler: (fn: () => void, ms: number) => void = (fn, ms) => {
  const t = setTimeout(fn, ms);
  // Don't let a pending retry keep the daemon process alive on shutdown.
  if (typeof (t as any).unref === "function") (t as any).unref();
};
export function _setRetryScheduler(fn: (cb: () => void, ms: number) => void) {
  _retryScheduler = fn;
}
export function _resetRetryScheduler() {
  _retryScheduler = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (typeof (t as any).unref === "function") (t as any).unref();
  };
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

/**
 * Signal a headless child AND its descendants. Headless agents are spawned
 * `detached` (see spawner.ts), so the child leads its own process group whose
 * pgid equals its pid. Killing the negative pid (`-pid`) signals the whole
 * group — the claude CLI's own children (MCP servers, tool subprocesses) die
 * with it instead of being orphaned. Falls back to a direct child.kill() if
 * the group signal fails (e.g. Windows, or the group already gone). Both
 * branches are best-effort: a dead process throws ESRCH, which we swallow.
 */
function signalChildTree(child: any, sig: NodeJS.Signals) {
  if (typeof child.pid === "number" && process.platform !== "win32") {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      // group gone or never formed — fall through to the direct kill
    }
  }
  try {
    child.kill(sig);
  } catch {}
}

export function killAgent(agentId: string) {
  const agent = agents.get(agentId);
  if (!agent) return false;

  // Mark as killed so the headless child's close-handler suppresses its own
  // (completed/errored) AGENT_TERMINATED emit — we emit reason:"killed" here.
  agent.killed = true;

  // Headless agents own a real child process. Interactive agents are driven
  // through a PTY. Kill whichever this agent actually has — the old code only
  // handled the PTY path, so killing a headless agent was a silent no-op and
  // the process kept running (user could interrupt but not kill).
  const child = agent.childProcess;
  if (child) {
    signalChildTree(child, "SIGTERM");
    // Escalate to SIGKILL if SIGTERM didn't bring it down within the grace window.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        signalChildTree(child, "SIGKILL");
      }
    }, 5000);
  } else if (agent.mode === "interactive" && agent.terminalId) {
    // Only interactive agents are PTY-backed. A headless agent parked in
    // "retrying" has childProcess=null and a zana-hl-* terminalId that was
    // never a PTY — routing it here would load node-pty (throwing on a
    // headless-only daemon) to kill a terminal that doesn't exist. The
    // `agent.killed` flag set above is what actually cancels its pending
    // retry (see maybeScheduleTransientRetry's guard).
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

  const agent: any = {
    id: agentId,
    profileId: profile.id,
    profileName: profile.displayName,
    profileIcon: profile.icon || "🤖",
    terminalId,
    mode: "headless",
    state: "active",
    model: routedProfile.model || "default",
    pid: null,
    spawnedAt: Date.now(),
    lastActivity: Date.now(),
    toolsAllowed: profile.allowedTools?.length || null,
    toolsTotal: null,
    tokenCount: 0,
    lastAction: "Running headless...",
    parentAgentId: options.parentAgentId || null,
    result: null,
    // --- resume / retry bookkeeping ---
    // claudeSessionId is populated from the stream-json init frame below; the
    // prompt + cwd are retained so a transient-error retry or boot-time crash
    // recovery can re-spawn this exact worker with `--resume`.
    claudeSessionId: null,
    prompt: options.prompt ?? null,
    cwd,
    retryAttempts: 0,
  };

  agents.set(agentId, agent);

  // Spawn (or re-spawn, on transient-error retry) the underlying claude child
  // and attach all stream/exit monitors. Factored into launchHeadlessChild so a
  // retry re-runs the exact same wiring against a fresh child, reusing the
  // captured session id via `--resume`.
  launchHeadlessChild(agent, routedProfile, options, { resume: false });

  notifyChange();
  bus.emit(EVENTS.AGENT_SPAWNED, { agentId, profileId: profile.id, mode: "headless" });

  return { agentId, terminalId };
}

/**
 * Boot-time crash recovery: re-spawn a headless worker that died when a
 * previous daemon crashed, resuming its claude conversation via
 * `--resume <claudeSessionId>`. Driven by persistence.recoverOrphanedAgents()'s
 * "resumable" bucket (dead pid, headless, has session id + prompt).
 *
 * Rebuilds a fresh agent record from the snapshot (a new id — the dead one is
 * gone) and relaunches with the captured session so the work continues instead
 * of being abandoned. Returns the new agentId, or null if the snapshot lacks
 * the data needed to resume.
 */
export function resumeHeadlessAgent(snapshot: any) {
  if (!snapshot?.claudeSessionId || !snapshot?.prompt) return null;

  const agentId = crypto.randomUUID();
  const terminalId = snapshot.terminalId || `zana-hl-${agentId.slice(0, 8)}`;
  const cwd = snapshot.cwd || process.env.HOME;
  const routedProfile = {
    id: snapshot.profileId,
    displayName: snapshot.profileName || snapshot.profileId,
    model: snapshot.model || undefined,
  };
  const options = { prompt: snapshot.prompt, cwd, terminalId, parentAgentId: snapshot.parentAgentId || null };

  const agent: any = {
    id: agentId,
    profileId: snapshot.profileId,
    profileName: snapshot.profileName || snapshot.profileId,
    profileIcon: "🤖",
    terminalId,
    mode: "headless",
    state: "active",
    model: snapshot.model || "default",
    pid: null,
    spawnedAt: Date.now(),
    lastActivity: Date.now(),
    toolsAllowed: null,
    toolsTotal: null,
    tokenCount: 0,
    lastAction: "Resuming after daemon restart...",
    parentAgentId: snapshot.parentAgentId || null,
    result: null,
    claudeSessionId: snapshot.claudeSessionId,
    prompt: snapshot.prompt,
    cwd,
    // Carry forward the prior retry count so a worker that crashed mid-retry
    // doesn't get a fresh full budget on every daemon restart.
    retryAttempts: snapshot.retryAttempts ?? 0,
    resumedFromCrash: true,
  };

  agents.set(agentId, agent);
  launchHeadlessChild(agent, routedProfile, options, { resume: true });
  notifyChange();
  bus.emit(EVENTS.AGENT_SPAWNED, { agentId, profileId: snapshot.profileId, mode: "headless", resumed: true });

  return agentId;
}

// Spawn the claude child for a headless agent record and wire up stdout/stderr
// parsing, the inactivity timeout, and the exit handler (which drives the
// transient-error retry loop). Called once on initial spawn and again per
// retry. On a retry, `opts.resume` is true and the agent's captured
// `claudeSessionId` is passed through so the conversation is preserved.
function launchHeadlessChild(
  agent: any,
  routedProfile: any,
  options: any,
  opts: { resume: boolean },
) {
  const agentId = agent.id;
  const profileId = agent.profileId;

  // On a `--resume` re-spawn the prior transcript (which already holds the
  // original task and whatever progress was made before the transient failure)
  // is replayed from disk. Re-sending the ORIGINAL prompt as the next turn
  // would re-ask the whole task on top of that progress; instead send a short
  // continuation nudge so the worker picks up where it left off. A cold spawn
  // sends the real prompt as before.
  const RESUME_NUDGE = "Continue the task from where you left off before the interruption.";
  const child = spawnHeadless(routedProfile, {
    name: `${agent.profileName} [${agentId.slice(0, 6)}]`,
    cwd: agent.cwd,
    prompt: opts.resume ? RESUME_NUDGE : options.prompt,
    terminalId: agent.terminalId,
    profileId,
    multiTurn: options.multiTurn || false,
    resumeSessionId: opts.resume ? agent.claudeSessionId || undefined : undefined,
  });

  agent.pid = child.pid;
  agent.childProcess = child;
  // Fresh stdout buffer per (re)spawn — a retry starts a new transcript.
  let outputBuffer = "";
  agent.outputBuffer = "";
  // The claude CLI writes API errors (429/529/transport) to STDERR, not the
  // stream-json stdout. Accumulate it untruncated so the transient-error
  // classifier at close time sees the real error text (agent.lastAction is
  // only an 80-char stamp — too lossy to classify on). Bounded to avoid
  // unbounded growth on a chatty stderr.
  let stderrBuffer = "";
  agent.stderrBuffer = "";

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
        // The first stream-json line is the init/system frame carrying the
        // claude session id. Capture it so a transient-error retry (and
        // boot-time crash recovery) can re-spawn this worker with
        // `--resume <id>` and preserve the conversation. Older CLIs put it on
        // the top-level `session_id`; tolerate both shapes.
        if (agent.claudeSessionId == null) {
          const sid = msg.session_id || msg.sessionId;
          if (typeof sid === "string" && sid.length > 0) {
            agent.claudeSessionId = sid;
          }
        }
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
    // Keep the last ~8KB of stderr — enough to hold an API error message for
    // transient-failure classification without growing without bound.
    stderrBuffer = (stderrBuffer + text).slice(-8192);
    agent.stderrBuffer = stderrBuffer;
    if (text.includes("error") || text.includes("Error")) {
      agent.lastAction = `Error: ${text.slice(0, 80)}`;
    }
  });

  // Configurable timeout for headless agents
  const AGENT_TIMEOUT_MS = (moduleConfig.getModuleConfig("system")?.agentTimeoutMinutes || 10) * 60 * 1000;
  const timeoutHandle = setTimeout(() => {
    if (getAgent(agentId)?.state === "active") {
      console.warn(`[agent-manager] agent ${agentId} timed out after ${AGENT_TIMEOUT_MS / 60000}min, killing`);
      // Signal the whole group (child is detached) so the timed-out agent's
      // grandchildren don't outlive it as orphans.
      signalChildTree(child, "SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          signalChildTree(child, "SIGKILL");
        }
      }, 5000);
    }
  }, AGENT_TIMEOUT_MS);

  child.on("error", (err: any) => {
    clearTimeout(timeoutHandle);
    console.error(`[agent-manager] spawn error for ${agentId}:`, err.message);
    agent.state = "error";
    agent.lastAction = `Spawn error: ${err.message}`;
    notifyChange();
    emitTerminated(agentId, profileId, "spawn-error", { error: err.message });
    const resilienceMod = require("../modules/loader").getModule?.("resilience");
    resilienceMod?.api?.recordFailure?.("agent-spawn");
  });

  child.on("close", (code: number) => {
    clearTimeout(timeoutHandle);
    // killAgent() already emitted reason:"killed" and set state — don't double-emit
    // a completed/errored termination for a process we deliberately tore down.
    if (agent.killed) {
      persistAgentRun(agent, code);
      return;
    }

    // Transient-error retry: a nonzero exit whose captured output looks like a
    // rate-limit / 529 overload / network blip is re-spawned with `--resume`
    // after a backoff, preserving the conversation. Structural failures
    // (auth/quota/misconfig) and exhausted attempts fall through to normal
    // termination. Gated off by setting transientRetryMaxAttempts to 0.
    if (code !== 0 && maybeScheduleTransientRetry(agent, routedProfile, options)) {
      return; // parked in "retrying"; do NOT terminate or persist yet
    }

    agent.state = code === 0 ? "terminated" : "errored";
    agent.lastAction = code === 0 ? "Completed" : `Exited (code ${code})`;
    notifyChange();
    emitTerminated(agentId, profileId, code === 0 ? "completed" : "errored", {
      exitCode: code,
      output: agent.result || null,
    });
    if (code === 0) {
      const resilienceMod = require("../modules/loader").getModule?.("resilience");
      resilienceMod?.api?.recordSuccess?.("agent-spawn");
    }
    // Post-run anomaly detection: flag a run that completed but looks unhealthy
    // (nonzero exit, near a cost/time/token ceiling). Pure detector lives in
    // @zana-ai/work; reach it via lazy require (core↔work cycle — see ADR 0001).
    // Best-effort: never let detection block termination/persistence.
    try {
      const detect = require("@zana-ai/work").runs?.anomaly?.detectAnomalies;
      const verdict = detect ? detect({ ...agent, exitCode: code }) : null;
      if (verdict && verdict.anomalies.length > 0) {
        agent.anomalies = verdict.anomalies;
        agent.anomalySeverity = verdict.severity;
        bus.emit(EVENTS.AGENT_ANOMALY, {
          agentId,
          profileId,
          severity: verdict.severity,
          anomalies: verdict.anomalies,
        });
      }
    } catch {
      // detection unavailable (e.g. work not loaded) — skip silently.
    }
    persistAgentRun(agent, code);
  });
}

// Decide whether a just-exited headless worker should be retried after a
// transient failure, and if so park it in "retrying" and arm the backoff timer.
// Returns true when a retry was scheduled (caller must NOT terminate), false
// when the caller should proceed with normal termination.
//
// Retry requires ALL of:
//   - a captured claudeSessionId (without it `--resume` can't preserve state)
//   - the failure classifies as transient (rate_limit / transport / overload)
//   - retryAttempts is below the configured ceiling
function maybeScheduleTransientRetry(agent: any, routedProfile: any, options: any): boolean {
  const maxAttempts = getTransientRetryMaxAttempts();
  if (maxAttempts <= 0) return false;
  if (agent.retryAttempts >= maxAttempts) return false;
  if (!agent.claudeSessionId) return false;

  // Classify on stderr FIRST (where the claude CLI writes API errors), then
  // fall back to stdout and the lastAction stamp. Joined so a transient marker
  // on either stream is seen even if the other holds unrelated narration.
  const errText = [agent.stderrBuffer, agent.outputBuffer, agent.lastAction]
    .filter((s: any) => typeof s === "string" && s.length > 0)
    .join("\n");
  const kind: ProbeFailureKind = classifySpawnError(errText);
  if (!isTransientFailure(kind)) return false;

  const attempt = agent.retryAttempts; // 0-based index into the backoff ladder
  const delayMs = getTransientRetryBackoffMs(attempt);
  agent.retryAttempts = attempt + 1;
  agent.state = "retrying";
  agent.lastFailureKind = kind;
  agent.lastAction = `Transient ${kind} — retry ${agent.retryAttempts}/${maxAttempts} in ${Math.round(delayMs / 1000)}s`;
  agent.childProcess = null;
  agent.pid = null;
  notifyChange();
  bus.emit(EVENTS.AGENT_RETRYING, {
    agentId: agent.id,
    profileId: agent.profileId,
    kind,
    attempt: agent.retryAttempts,
    maxAttempts,
    delayMs,
  });

  _retryScheduler(() => {
    const live = getAgent(agent.id);
    // A kill (or any external terminal transition) during the backoff window
    // cancels the retry — don't resurrect a worker the operator tore down.
    if (!live || live.killed || live.state !== "retrying") return;
    live.state = "active";
    live.lastAction = `Resuming (attempt ${live.retryAttempts}/${maxAttempts})`;
    notifyChange();
    launchHeadlessChild(live, routedProfile, options, { resume: true });
  }, delayMs);

  return true;
}
