// Capability probe (T3, deliberation/quorum gate).
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
// Tests inject fake deps via the `deps` parameter.

import * as crypto from "node:crypto";
import { getProbeConfig } from "./probe-config";
import { lookupProbeResult, recordProbeResult } from "./probe-cache";
import { spawnHeadlessAgent, getAgent, killAgent } from "./lifecycle";
import { bus, EVENTS } from "../events/bus";
import type { ProbeFailure, ProbeFailureKind, AgentProbedPayload } from "../events/deliberation-events";

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
  // cache rather than a fresh probe. Absent / false on a real probe.
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
const DEFAULT_PROBE_TIMEOUT_MS_FALLBACK = 90000;

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
