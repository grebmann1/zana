// T9 — zana_deliberate MCP tool family.
//
// Surface for multi-voice deliberation. Wires:
//   propose() → assembleCouncil() → [ collectReviews → recordVote × N
//   → synthesize → recordDissent × M → SYNTHESIZING → CONVERGING ]
//   → decide() → applyDecision()  → optionally reassembleCouncil
// until SETTLED or ESCALATED, then returns the final deliberation.
//
// Tools:
//   - zana_deliberate                — run the full loop
//   - zana_deliberation_status       — load by id
//   - zana_deliberation_list         — list (filter by state)
//   - zana_deliberation_override     — record human override (+SETTLED)
//
// Every external touchpoint is reachable via the optional `deps` argument so
// unit tests can exercise the full loop without booting the daemon.

import {
  collectReviews,
  type CollectedReview,
  type CollectReviewsDeps,
  type VoterSpec,
} from "./collect-reviews";
import {
  adjudicateEscalation,
  shouldJudge,
  type AdjudicateDeps,
} from "./judge";

// ─────────────────────────────────────────────────────────────────────────────
// Lazy module loaders (matches the pattern used in mcp-server.ts).
// ─────────────────────────────────────────────────────────────────────────────
function _work(): any { return require("@zana-ai/work"); }
function _core(): any { return require("@zana-ai/core"); }
function _delib(): any { return _work().deliberation; }

// Build the response when assembleCouncil/reassembleCouncil escalates.
// The full deliberation record carries `degradation[]` with typed
// per-voter probe failures, but the host LLM doesn't know to dig into
// that array — it usually summarizes the failure as "probe quorum
// lost" without naming voters. We project the most-recent
// degradation entry into `voterFailures[]` (chat-friendly:
// `{ profileId, leg, kind, reason }`) and add a `nextSteps` hint
// directly inside `_assemblyEscalation` / `_reassemblyEscalation` so
// the orchestrator surfaces the typed details verbatim.
//
// The full record is still spread at the top level for backward compat
// (callers that read `state`, `escalationReason`, `version`, `votes`,
// `degradation`, etc. continue to work). `verbose` is accepted for
// future-proofing but currently has no effect on the shape — there's
// no remaining reason to omit the slim helper fields.
function buildEscalationResponse(opts: {
  delib: any;
  outcome: "escalated_at_assembly" | "escalated_during_reassembly";
  reason: string;
  details: string;
  verbose: boolean;
}): any {
  const escKey = opts.outcome === "escalated_at_assembly"
    ? "_assemblyEscalation"
    : "_reassemblyEscalation";
  const degradation = Array.isArray(opts.delib?.degradation) ? opts.delib.degradation : [];
  const last = degradation[degradation.length - 1];
  const voterFailures = Array.isArray(last?.dropped)
    ? last.dropped.map((dv: any) => ({
        profileId: dv.profileId,
        leg: dv.leg ?? null,
        kind: dv.reason,
        reason: dv.detail ?? "",
      }))
    : [];
  return {
    ...opts.delib,
    _outcome: opts.outcome,
    [escKey]: {
      reason: opts.reason,
      details: opts.details,
      voterFailures,
      nextSteps:
        "Inspect ~/.zana/audit/audit.ndjson for full per-leg detail; clear stale probe cache " +
        "with `rm ~/.zana/probe-cache.json` if these failures look stale.",
    },
  };
}

// Hardcoded fallback when runtime-config doesn't carry default voter ids.
// FU-config-3 will land defaultVoterProfileIds in module config; for now any
// profile id may be passed through the args.voters array.
const DEFAULT_VOTER_PROFILE_IDS = ["architect", "security-reviewer", "researcher"];

// Sentinel thrown by checkCancelled() inside runDeliberationUnsafe — caught
// by runDeliberation, drives the deliberation to EXHAUSTED instead of
// ESCALATED. Distinct from a real crash so audit consumers can tell the
// difference between "operator cancelled" and "the orchestrator blew up".
class DeliberationCancelledError extends Error {
  code = "DELIBERATION_CANCELLED" as const;
  deliberationId: string;
  constructor(deliberationId: string) {
    super(`deliberation ${deliberationId} cancelled`);
    this.name = "DeliberationCancelledError";
    this.deliberationId = deliberationId;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Common types — exported so handlers in deliberate.test.ts can construct deps.
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliberateDeps extends CollectReviewsDeps {
  // Profile resolution — defaults to @zana-ai/core profileStore.
  getProfile?: (id: string) => any;
  // Probe wiring — defaults to @zana-ai/core agents.manager.
  probeAgent?: (profile: any, probe?: any, deps?: any) => Promise<any>;
  // Where to read context artifacts — defaults to @zana-ai/work runs.artifacts.
  getArtifact?: (id: string) => any;
  // Bound the orchestration loop — guards against runaway state-machine bugs
  // even though decide()/applyDecision() are supposed to terminate.
  // Default: 4 × rounds + 4 (covers REVIEWING + per-round CONVERGING + a few
  // applyDecision retries) — generous but finite.
  maxIterations?: number;
  // Judge wiring (only used when escalationStrategy resolves to judge/hybrid).
  // Defaults to core.agents.spawner.spawnOneShot. Tests stub this.
  spawnOneShot?: (
    profile: any,
    prompt: string,
    options?: { cwd?: string; timeout?: number },
  ) => Promise<{ output: string; exitCode: number }>;
  // CAS reader for voter rationales — defaults to work.runs.artifacts.readContentAddressed.
  readContentAddressed?: (hash: string) => Buffer | null;
}

export interface DeliberateArgs {
  question: string;
  // Either an explicit profile-id list, or a named role pack:
  //   { pack: "arch" | "code-review" | "plan" | "review", quantity?: number }
  // Pack-resolution lives in @zana-ai/work `role-packs` and is deterministic.
  voters?: string[] | { pack: string; quantity?: number };
  rounds?: number;
  quorum?: number | "majority" | "all";
  mode?: "synthesis" | "tally";
  riskTag?: "low" | "medium" | "high";
  context?: string[];
  // When true, await the full orchestration loop before returning the final
  // Deliberation record. Default false: return immediately with a stub
  // deliberation in PROPOSED state and let the caller poll
  // zana_deliberation_status. Async-by-default avoids the MCP-client timeout
  // problem that real-Claude voters trip (each can take 5-10 min).
  wait?: boolean;
  // Per-call override of the deliberation module's escalationStrategy
  // setting. "judge"/"hybrid" auto-resolves a non-high-risk ESCALATED
  // outcome via the judge profile; "human" leaves ESCALATED for manual
  // override. Omit to use the module-config default.
  escalationStrategy?: "human" | "judge" | "hybrid";
  // Slice C — Mid-deliberation human-in-loop nudge. When set, the orchestration
  // loop pauses after synthesizing round `afterRound` and exits with
  // _outcome="awaiting_nudge". Caller resumes via zana_deliberation_nudge with
  // either a free-text response or null/empty (skip). On resume, non-empty
  // response text is content-addressed and prepended into the next round's
  // voter prompt as a human-reviewer addendum.
  //
  // Off by default — must not change today's flow for any existing caller.
  humanNudge?: false | { afterRound: number; promptText?: string };
  // Slice D — Heterogeneous-model voters. Per-voter model override and/or
  // diversity preset, applied BEFORE the smoke probe so the probe validates
  // the actual model that will run.
  //
  //   voterModels — { profileId → modelId } map. Each entry replaces the
  //                 profile's declared model for THIS deliberation only.
  //   modelDiversity — "uniform" (default; every voter uses its profile model)
  //                    or "mixed" (rotate through a small set of distinct
  //                    Claude models for monoculture-resistance).
  voterModels?: Record<string, string>;
  modelDiversity?: "uniform" | "mixed";
  // On assembly/reassembly escalation, return the full deliberation
  // record (including `degradation[]`). Default false: the response is a
  // slim shape with `voterFailures[]` and `nextSteps` so the host LLM
  // can surface the typed probe failures to the user.
  verbose?: boolean;
  // Bypass the capability-probe gate. Use for low-stakes / chat-driven
  // brainstorms where probe latency outweighs the value of catching a
  // broken voter early. If a voter is genuinely broken, the failure
  // surfaces in the collect-reviews round instead of probe time.
  // Default false (probes run as today).
  skipProbe?: boolean;
  deps?: DeliberateDeps;
}

// In-memory tracking of running orchestration loops, keyed by deliberationId.
// Used to (a) prevent double-launching the same deliberation, (b) coordinate
// cancellation, and (c) hold the per-run kill switch + active voter agent IDs
// so zana_deliberate_cancel can terminate spawned voters.
//
// Persistence of state already lives in the checkpoint store; this map is
// purely for live-process coordination.
interface ActiveRun {
  startedAt: number;
  cancelled: boolean;
  killAgent: (agentId: string) => boolean;
  liveAgentIds: Set<string>;
}
const activeRuns = new Map<string, ActiveRun>();

/** Test-only: snapshot active runs (used by deliberate-async.test.ts). */
export function _getActiveRunsForTest(): { deliberationId: string; startedAt: number; cancelled: boolean }[] {
  return Array.from(activeRuns.entries()).map(([deliberationId, info]) => ({
    deliberationId,
    startedAt: info.startedAt,
    cancelled: info.cancelled,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberate handler
// ─────────────────────────────────────────────────────────────────────────────
export async function deliberateHandler(args: DeliberateArgs): Promise<any> {
  if (!args || typeof args !== "object" || typeof args.question !== "string" || args.question.trim() === "") {
    throw new Error("zana_deliberate: question is required");
  }
  const deps = args.deps ?? {};

  const work = _work();
  const delib = _delib();
  const core = _core();

  const rt = delib.getRuntimeConfig();
  // Accept either a string[] (legacy form) or { pack, quantity } (Slice A).
  // normalizeVotersInput throws on malformed input and unknown pack ids.
  let voterIds: string[];
  let rolePackAudit: { id: string; quantity: number } | null = null;
  if (args.voters && !Array.isArray(args.voters) && typeof (args.voters as any).pack === "string") {
    rolePackAudit = {
      id: (args.voters as any).pack,
      quantity: typeof (args.voters as any).quantity === "number" ? (args.voters as any).quantity : 3,
    };
  }
  try {
    voterIds = delib.normalizeVotersInput(args.voters, DEFAULT_VOTER_PROFILE_IDS);
  } catch (err: any) {
    throw new Error(`zana_deliberate: ${err?.message ?? String(err)}`);
  }
  if (!Array.isArray(voterIds) || voterIds.length === 0) {
    voterIds = DEFAULT_VOTER_PROFILE_IDS;
  }

  const rounds = typeof args.rounds === "number" && args.rounds >= 1
    ? Math.floor(args.rounds)
    : Math.max(1, Math.floor(rt.defaultRounds));

  // runtime-config carries quorum as a string ("majority"|"all"|"<int>").
  let quorumSpec: number | "majority" | "all";
  if (args.quorum !== undefined) {
    quorumSpec = args.quorum;
  } else {
    const dq = rt.defaultQuorum;
    if (dq === "majority" || dq === "all") quorumSpec = dq;
    else {
      const n = Number(dq);
      quorumSpec = Number.isFinite(n) && n >= 1 ? n : "majority";
    }
  }

  const mode: "synthesis" | "tally" = args.mode === "tally" ? "tally" : (rt.defaultMode || "synthesis");
  const riskTag: "low" | "medium" | "high" = args.riskTag ?? "medium";

  // Resolve profiles up-front — assembleCouncil + collectReviews both need them.
  const getProfile = deps.getProfile ?? ((id: string) => core.agents.profileStore.getProfile(id));
  let candidates: { profileId: string; profile: any }[] = [];
  for (const id of voterIds) {
    const profile = getProfile(id) || getProfile(`built-in-${id}`);
    if (!profile) {
      throw new Error(`zana_deliberate: unknown profile: ${id}`);
    }
    // assembleCouncil rejects duplicate candidate profileIds — surface that here.
    if (candidates.some((c) => c.profileId === id)) {
      throw new Error(`zana_deliberate: duplicate voter profileId: ${id}`);
    }
    candidates.push({ profileId: id, profile });
  }

  // Slice D — Heterogeneous-model voters. Apply per-voter model override
  // BEFORE assembleCouncil so the smoke probe validates the actual model.
  // Validation: refuse override to a model that isn't in the local registry.
  const voterModels = (args.voterModels && typeof args.voterModels === "object")
    ? args.voterModels
    : {};
  const modelDiversity = args.modelDiversity === "mixed" ? "mixed" : "uniform";
  const MIXED_LADDER = ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"];
  // Best-effort registry — anything advertised as a model on a known profile
  // is acceptable. We collect the set lazily; a missing registry simply skips
  // the strict-validation gate.
  const knownModels = new Set<string>();
  try {
    const profiles = core.agents.profileStore.listProfiles?.() ?? [];
    for (const p of profiles) {
      if (typeof p?.model === "string" && p.model.length > 0) knownModels.add(p.model);
    }
  } catch {}
  for (const m of MIXED_LADDER) knownModels.add(m);

  if (Object.keys(voterModels).length > 0 || modelDiversity === "mixed") {
    candidates = candidates.map((c, i) => {
      let resolvedModel: string | undefined = voterModels[c.profileId];
      if (!resolvedModel && modelDiversity === "mixed") {
        resolvedModel = MIXED_LADDER[i % MIXED_LADDER.length];
      }
      if (!resolvedModel) return c;
      if (knownModels.size > 0 && !knownModels.has(resolvedModel)) {
        throw new Error(
          `zana_deliberate: voterModels[${c.profileId}]="${resolvedModel}" is not in the local model registry`,
        );
      }
      // Clone the profile so we don't mutate the shared profile-store entry.
      return { profileId: c.profileId, profile: { ...c.profile, model: resolvedModel } };
    });
  }

  // Slice B — generalist-seat invariant. When the council size meets the
  // configured threshold and no current voter carries the `generalist` flag,
  // append the configured generalist profile (default `researcher`).
  //
  // Apply the invariant only on the default-voters path or the named-pack
  // path — when the caller passed an explicit profile-id array, honor it
  // verbatim (existing callers, including tests, may rely on the exact list).
  const explicitVoters = Array.isArray(args.voters) && args.voters.length > 0;
  const applySeatInvariant = !explicitVoters;
  const generalistSeatCfg = {
    enabled: applySeatInvariant && (rt.generalistSeat?.enabled ?? true),
    profileId: rt.generalistSeat?.profileId ?? "researcher",
    threshold: typeof rt.generalistSeatThreshold === "number" ? rt.generalistSeatThreshold : 3,
  };
  const seatOutcome = delib.applyGeneralistSeatInvariant(
    candidates,
    generalistSeatCfg,
    getProfile,
  );
  candidates = seatOutcome.candidates;
  const appendedGeneralist = seatOutcome.appended;
  if (appendedGeneralist) {
    voterIds = [...voterIds, appendedGeneralist.profileId];
  }

  // Build prompt snapshot (question + optional context artifacts).
  let promptSnapshot = `# Deliberation\n\n## Question\n${args.question.trim()}\n`;
  if (Array.isArray(args.context) && args.context.length > 0) {
    promptSnapshot += `\n## Context\n`;
    const getArtifact = deps.getArtifact ?? ((id: string) => work.runs.artifacts.getArtifact(id));
    for (const aid of args.context) {
      try {
        const a = getArtifact(aid);
        if (a) {
          promptSnapshot += `\n### Artifact: ${a.title || aid}\n${a.content || ""}\n`;
        }
      } catch {}
    }
  }

  // 1. Propose.
  const proposed = delib.propose({
    question: args.question,
    voters: voterIds.map((id) => ({ profileId: id })),
    rounds,
    quorum: quorumSpec,
    mode,
    riskTag,
    promptSnapshot,
    context: Array.isArray(args.context) && args.context.length > 0
      ? { artifactRefs: [...args.context] }
      : undefined,
  });

  // Slice B — emit deliberation:generalistAdded once the deliberation has an
  // id. Best-effort; bus errors do not block the run.
  if (appendedGeneralist) {
    try {
      const ev = core.events;
      ev.bus.emit(ev.EVENTS.DELIBERATION_GENERALIST_ADDED, {
        deliberationId: proposed.id,
        profileId: appendedGeneralist.profileId,
        reason: "no_generalist_in_council",
        ts: new Date().toISOString(),
      });
    } catch {}
  }
  // Slice A — record role-pack provenance for replay.
  if (rolePackAudit) {
    try {
      const ev = core.events;
      // Reuse the proposed event channel if available; otherwise fall back to a
      // best-effort console trace that won't perturb tests.
      ev.bus.emit("deliberation:rolePack", {
        deliberationId: proposed.id,
        rolePack: rolePackAudit,
        ts: new Date().toISOString(),
      });
    } catch {}
  }

  // Register active run record up front so cancel can find it even if the
  // background runner hasn't yet entered its first await.
  const killAgent = deps.killAgent ?? ((id: string) => {
    try { return core.agents.manager.killAgent(id); } catch { return false; }
  });
  const activeRun: ActiveRun = {
    startedAt: Date.now(),
    cancelled: false,
    killAgent,
    liveAgentIds: new Set<string>(),
  };
  activeRuns.set(proposed.id, activeRun);

  // Resolve escalation strategy: per-call arg wins over module config.
  const escalationStrategy: "human" | "judge" | "hybrid" =
    args.escalationStrategy
    ?? (rt.escalationStrategy as "human" | "judge" | "hybrid" | undefined)
    ?? "human";

  const ctx: RunDeliberationContext = {
    deliberationId: proposed.id,
    candidates,
    promptSnapshot,
    deps,
    rounds,
    getProfile,
    activeRun,
    escalationStrategy,
    humanNudge: typeof args.humanNudge === "object" && args.humanNudge !== null && typeof args.humanNudge.afterRound === "number"
      ? { afterRound: Math.floor(args.humanNudge.afterRound), promptText: args.humanNudge.promptText ?? "Optional input for next round (skip leaves it as-is):" }
      : null,
    verbose: args.verbose === true,
    skipProbe: args.skipProbe === true,
  };

  // 2. Default: detach the orchestration loop and return the proposed record.
  //    Caller polls zana_deliberation_status for progress / final outcome.
  if (args.wait !== true) {
    runDeliberation(ctx).catch(() => {
      // runDeliberation already records ESCALATED on crash; just clear tracker.
    }).finally(() => {
      activeRuns.delete(proposed.id);
    });
    return {
      ...delib.loadDeliberation(proposed.id),
      _outcome: "running",
      _async: true,
    };
  }

  // 3. wait=true — drive the loop inline (legacy / test mode).
  try {
    return await runDeliberation(ctx);
  } finally {
    activeRuns.delete(proposed.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runDeliberation — the orchestration loop.
//
// Pulled out of deliberateHandler so it can run detached from the MCP request
// (default async path) AND inline (wait=true). Crashes inside this function
// must NOT silently leak — record ESCALATED on the deliberation so callers
// polling status see a terminal state.
// ─────────────────────────────────────────────────────────────────────────────
interface RunDeliberationContext {
  deliberationId: string;
  candidates: { profileId: string; profile: any }[];
  promptSnapshot: string;
  deps: DeliberateDeps;
  rounds: number;
  getProfile: (id: string) => any;
  // Live coordination handle — runner checks `cancelled` between rounds and
  // registers spawned voter agents so zana_deliberate_cancel can kill them.
  activeRun: ActiveRun;
  // Resolved at deliberateHandler entry: per-call arg | module config | "human".
  // Threaded into the post-loop finalize step where the auto-judge gate runs.
  escalationStrategy: "human" | "judge" | "hybrid";
  // Slice C — when set, after synthesizing round `afterRound` the loop pauses
  // and exits with _outcome="awaiting_nudge". Resume via zana_deliberation_nudge.
  humanNudge: { afterRound: number; promptText: string } | null;
  // Slice C — when resuming after a nudge, the first iteration of the loop
  // must skip collect+synth (already done before the pause) and jump to decide.
  skipFirstCollectAndSynth?: boolean;
  // Plumbed from DeliberateArgs.verbose. Controls escalation-response shape
  // when assembleCouncil/reassembleCouncil escalates inside this loop.
  verbose: boolean;
  // Plumbed from DeliberateArgs.skipProbe. When true, bypass the capability
  // probe and treat every candidate as a healthy voter.
  skipProbe?: boolean;
}

async function runDeliberation(ctx: RunDeliberationContext): Promise<any> {
  const delib = _delib();
  const { deliberationId } = ctx;

  try {
    const result = await runDeliberationUnsafe(ctx);
    return await maybeAdjudicate(ctx, result);
  } catch (err: any) {
    // Background-runner crash protocol: drive the deliberation to a terminal
    // state so polling callers don't get stuck on REVIEWING/CONVERGING forever.
    //
    // Cancellation is a distinct path — drive to EXHAUSTED (PROPOSED/CONVERGING
    // permit it directly; REVIEWING/SYNTHESIZING must go via ESCALATED first).
    const cancelled = err instanceof DeliberationCancelledError;
    try {
      const fresh = delib.loadDeliberation(deliberationId);
      if (fresh && fresh.state !== "SETTLED" && fresh.state !== "ESCALATED" && fresh.state !== "EXHAUSTED") {
        try {
          if (cancelled) {
            // Try EXHAUSTED first; if illegal from current state, escalate then exhaust.
            try {
              delib.transition(deliberationId, "EXHAUSTED", {}, { expectedVersion: fresh.version });
            } catch {
              const f2 = delib.loadDeliberation(deliberationId);
              if (f2 && f2.state !== "ESCALATED" && f2.state !== "EXHAUSTED" && f2.state !== "SETTLED") {
                try {
                  delib.transition(deliberationId, "ESCALATED", { escalationReason: "explicit" }, { expectedVersion: f2.version });
                } catch {}
              }
            }
          } else {
            delib.transition(deliberationId, "ESCALATED", { escalationReason: "explicit" }, { expectedVersion: fresh.version });
          }
        } catch {}
      }
    } catch {}

    // Cancellation is an authorized terminal — don't propagate as an error.
    if (cancelled) {
      const final = delib.loadDeliberation(deliberationId);
      return { ...final, _outcome: "cancelled" };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-loop adjudication gate.
//
// If the orchestration loop landed on ESCALATED and the configured strategy
// asks for it, spawn the judge to auto-resolve. Errors from the judge are
// caught here — the deliberation stays ESCALATED so a human can call
// zana_deliberation_override as a fallback. The error is surfaced to the
// caller via `_judgeError` on the result.
// ─────────────────────────────────────────────────────────────────────────────
async function maybeAdjudicate(ctx: RunDeliberationContext, result: any): Promise<any> {
  const delib = _delib();

  // Re-load fresh — runDeliberationUnsafe's return value may be a snapshot
  // from before the final transition (e.g. assembly-escalation early returns).
  const fresh = delib.loadDeliberation(ctx.deliberationId);
  if (!fresh) return result;

  if (!shouldJudge(fresh, ctx.escalationStrategy)) {
    return result;
  }

  // Build judge deps from caller-provided overrides where applicable.
  const judgeDeps: AdjudicateDeps = {};
  if (typeof (ctx.deps as any).spawnOneShot === "function") {
    judgeDeps.spawnOneShot = (ctx.deps as any).spawnOneShot;
  }
  if (ctx.deps.getProfile) judgeDeps.getProfile = ctx.deps.getProfile;
  if (typeof (ctx.deps as any).readContentAddressed === "function") {
    judgeDeps.readContentAddressed = (ctx.deps as any).readContentAddressed;
  }

  try {
    const verdict = await adjudicateEscalation(ctx.deliberationId, judgeDeps);
    const after = delib.loadDeliberation(ctx.deliberationId);
    return {
      ...after,
      _outcome: "judged",
      _judge: { verdict: verdict.verdict, humanId: verdict.humanId },
    };
  } catch (err: any) {
    return { ...result, _judgeError: err?.message ?? String(err) };
  }
}

async function runDeliberationUnsafe(ctx: RunDeliberationContext): Promise<any> {
  const work = _work();
  const delib = _delib();
  const core = _core();
  const { deliberationId, candidates, promptSnapshot, deps, rounds, getProfile, activeRun } = ctx;

  // Cancellation observation point. Throws to abort the orchestration loop —
  // the outer runDeliberation catch handles transition-to-terminal-state.
  const checkCancelled = () => {
    if (activeRun.cancelled) {
      throw new DeliberationCancelledError(deliberationId);
    }
  };

  // Wrap the caller's spawnHeadlessAgent so every voter we launch is registered
  // for kill on cancellation.
  const baseSpawn = deps.spawnHeadlessAgent ?? ((profile: any, options: any) =>
    core.agents.manager.spawnHeadlessAgent(profile, options));
  const trackedSpawn = (profile: any, options: any) => {
    const result = baseSpawn(profile, options);
    if (result?.agentId) activeRun.liveAgentIds.add(result.agentId);
    return result;
  };

  // 2. Assemble the initial council. assembleCouncil probes each candidate and
  //    transitions PROPOSED → REVIEWING (or PROPOSED → ESCALATED on quorum loss).
  // When the caller opts out of probing (low-stakes / brainstorm flows), swap
  // in a stub that reports every candidate as healthy. The rest of
  // assembleCouncil's READY-path machinery still runs, so degradation, audit,
  // and quorum bookkeeping all stay consistent — the probe is just bypassed.
  // If a voter is actually broken, the failure surfaces at review time
  // (one collect-reviews round-trip later) instead of at probe time.
  const stubProbeForSkip = async (profile: any) => ({
    ok: true,
    latencyMs: 0,
    failures: [],
    modelId: profile?.model || "unknown",
    probeId: `skipped-${profile?.id ?? "anonymous"}`,
    legs: [],
    cached: false,
  });
  const probeAgent = ctx.skipProbe
    ? stubProbeForSkip
    : (deps.probeAgent ?? core.agents.manager.probeAgent);
  const assembleDeps: any = {
    probeAgent,
    spawnHeadlessAgent: trackedSpawn,
  };
  if (deps.getAgent) assembleDeps.getAgent = deps.getAgent;
  if (deps.killAgent) assembleDeps.killAgent = deps.killAgent;

  checkCancelled();

  // Slice C — when resuming after a human-nudge pause, the deliberation is
  // already past PROPOSED; skip the initial assembleCouncil call.
  const preState: string = (delib.loadDeliberation(deliberationId) || {}).state || "PROPOSED";
  const isResumingAfterNudge = preState === "CONVERGING" || preState === "REVIEWING";

  const assembleOutcome = isResumingAfterNudge
    ? { kind: "READY" as const }
    : await delib.assembleCouncil({
        deliberationId,
        candidates,
        deps: assembleDeps,
      });
  if ((assembleOutcome as any).kind === "ESCALATED") {
    const esc = assembleOutcome as any;
    return buildEscalationResponse({
      delib: delib.loadDeliberation(deliberationId),
      outcome: "escalated_at_assembly",
      reason: esc.reason,
      details: esc.details,
      verbose: ctx.verbose,
    });
  }

  // 3. Per-round loop.
  const maxIterations = typeof deps.maxIterations === "number" && deps.maxIterations > 0
    ? Math.floor(deps.maxIterations)
    : Math.max(8, rounds * 4 + 4);
  let iter = 0;

  let d: any = delib.loadDeliberation(deliberationId);
  let skipFirst = ctx.skipFirstCollectAndSynth === true;
  while (d.state === "REVIEWING" || d.state === "CONVERGING") {
    checkCancelled();
    if (++iter > maxIterations) {
      throw new Error(
        `zana_deliberate: orchestration loop exceeded ${maxIterations} iterations on deliberation ${deliberationId} (state=${d.state})`,
      );
    }

    if (skipFirst) {
      // Slice C resume — collect+synth for the paused round already happened.
      // Jump straight to decide() with the existing record. The pause itself
      // recorded the nudge as a humanNudges entry; the next round's prompt
      // will pick up the addendum via `promptSnapshotForRound` below on the
      // NEXT iteration.
      skipFirst = false;
      const decision = delib.decide({ deliberation: d });
      if (decision.action === "ADVANCE_ROUND") {
        const prevDissenters = d.dissent.filter((x: any) => x.round === d.currentRound).map((x: any) => x.profileId);
        const reOutcome = await delib.reassembleCouncil({
          deliberationId: d.id,
          candidates,
          previousDissenterProfileIds: prevDissenters,
          expectedSourceState: "CONVERGING",
          deps: assembleDeps,
        });
        if (reOutcome.kind === "ESCALATED") {
          return buildEscalationResponse({
            delib: delib.loadDeliberation(d.id),
            outcome: "escalated_during_reassembly",
            reason: reOutcome.reason,
            details: reOutcome.details,
            verbose: ctx.verbose,
          });
        }
      } else {
        await delib.applyDecision(d.id, decision, { expectedVersion: d.version });
      }
      d = delib.loadDeliberation(d.id);
      continue;
    }

    // 3a. Spawn-and-collect reviews for the current round.
    let promptSnapshotForRound = promptSnapshot;
    // Slice C — if any humanNudges have been recorded, append the most-recent
    // verbatim text as a "Human-reviewer addendum" so subsequent voters see it.
    if (Array.isArray(d.humanNudges) && d.humanNudges.length > 0) {
      const lastUser = [...d.humanNudges].reverse().find((n: any) => n.contributedBy === "user" && n.textHash);
      if (lastUser) {
        try {
          const buf = work.runs.artifacts.readContentAddressed(lastUser.textHash);
          const text = buf ? String(buf) : "";
          if (text.length > 0) {
            promptSnapshotForRound = `${promptSnapshot}\n\n## Human-reviewer addendum (after round ${lastUser.afterRound})\n${text}\n`;
          }
        } catch {}
      }
    }
    const voterSpecs: VoterSpec[] = d.voters.map((v: any) => ({
      agentId: v.agentId,
      profileId: v.profileId,
      modelId: v.modelId,
      profile: candidates.find((c) => c.profileId === v.profileId)?.profile ?? getProfile(v.profileId) ?? { id: v.profileId, model: v.modelId },
    }));
    // currentRound is 0 during REVIEWING (synth bumps to 1 → CONVERGING) and
    // 1+ during CONVERGING. Map REVIEWING to round 1 explicitly.
    const round = d.state === "REVIEWING" ? 1 : d.currentRound;

    // Resolve voter timeout from runtime config unless caller deps override.
    // The runtime config knob (voterTimeoutMs) lets operators tune via the
    // deliberation module config without a code change.
    const reviewDeps: any = { ...deps, spawnHeadlessAgent: trackedSpawn };
    if (typeof deps.timeoutMs !== "number") {
      const cfgTimeout = delib.getRuntimeConfig?.()?.voterTimeoutMs;
      if (typeof cfgTimeout === "number" && cfgTimeout > 0) {
        reviewDeps.timeoutMs = cfgTimeout;
      }
    }
    const reviews = await collectReviews(
      { round, promptSnapshot: promptSnapshotForRound, voters: voterSpecs },
      reviewDeps,
    );
    checkCancelled();

    // OCC retry bound — sourced from runtime config so operators can tune it
    // without a code change. Falls back to 3 for safety if config is missing
    // or yields a non-positive value (e.g. test seams that stub the config).
    const occMaxRetries = (() => {
      const v = delib.getRuntimeConfig?.()?.occMaxRetries;
      return typeof v === "number" && v >= 1 ? Math.floor(v) : 3;
    })();

    // 3b. Record votes — each with optimistic-concurrency retry.
    for (const r of reviews) {
      let attempts = 0;
      // applyDecision supports up to occMaxRetries; do the same here.
      while (true) {
        const fresh = delib.loadDeliberation(d.id);
        if (!fresh) throw new Error(`zana_deliberate: deliberation vanished mid-round: ${d.id}`);
        try {
          delib.recordVote(d.id, {
            voterId: r.voterId,
            profileId: r.profileId,
            modelId: r.modelId,
            round: r.round,
            bit: r.bit,
            rationaleHash: r.rationaleHash,
            promptSnapshotHash: fresh.promptSnapshotHash,
            ts: new Date().toISOString(),
          }, { expectedVersion: fresh.version });
          break;
        } catch (err: any) {
          if (err && err.code === "STALE_DELIBERATION" && attempts < occMaxRetries) {
            attempts++;
            continue;
          }
          throw err;
        }
      }
    }

    // 3c. Synthesize on EVERY round — round 1 (REVIEWING → SYNTHESIZING →
    //     CONVERGING) AND rounds 2+ (CONVERGING → CONVERGING with the new
    //     synthesisHash patched in). Without this, CHANGES rationales from
    //     round 2+ would be tallied but never content-addressed or recorded
    //     as dissent — violating the design's "minority report MUST be
    //     preserved, never collapsed" bar (the bug QA caught).
    //
    //     synthesize() filters by deliberation.currentRound; in REVIEWING it's
    //     still 0 but the votes are tagged round=1, so we pass a snapshot with
    //     currentRound aligned to the round we just collected. Pure function —
    //     no state-machine side effects, safe in either state.
    d = delib.loadDeliberation(d.id);
    {
      const snapshotForSynth = { ...d, currentRound: round };
      const synth = delib.synthesize({ deliberation: snapshotForSynth, reviews }, {});

      // Record each dissent with OCC retry — match the recordVote retry
      // pattern. Without retries, a parallel mutation between load+record
      // would surface as STALE_DELIBERATION even though the dissent is safe
      // to append idempotently.
      for (const dis of synth.dissents) {
        let dattempts = 0;
        while (true) {
          const fresh = delib.loadDeliberation(d.id);
          if (!fresh) throw new Error(`zana_deliberate: deliberation vanished mid-round: ${d.id}`);
          try {
            delib.recordDissent(d.id, { ...dis, ts: new Date().toISOString() }, { expectedVersion: fresh.version });
            break;
          } catch (err: any) {
            if (err && err.code === "STALE_DELIBERATION" && dattempts < occMaxRetries) {
              dattempts++;
              continue;
            }
            throw err;
          }
        }
      }

      // Patch synthesisHash onto the deliberation. Two paths:
      //   - Round 1 (state=REVIEWING): REVIEWING → SYNTHESIZING (sets
      //     synthesisHash) → CONVERGING (bumps currentRound to round 1).
      //   - Round 2+ (state=CONVERGING): CONVERGING → CONVERGING self-loop
      //     (legal per TRANSITIONS table) with synthesisHash patched. The
      //     CONVERGING → CONVERGING self-loop already exists for round
      //     bumping; reusing it for round-N synthesis is well-formed because
      //     synthesisHash is in PATCHABLE_FIELDS (see run.ts). No round bump
      //     here — applyDecision/reassembleCouncil drives that on ADVANCE.
      const fresh = delib.loadDeliberation(d.id);
      if (fresh.state === "REVIEWING") {
        delib.transition(d.id, "SYNTHESIZING", { synthesisHash: synth.reportHash }, { expectedVersion: fresh.version });
        const f2 = delib.loadDeliberation(d.id);
        delib.transition(d.id, "CONVERGING", { currentRound: round }, { expectedVersion: f2.version });
      } else {
        // state === "CONVERGING" — patch synthesisHash onto the existing
        // CONVERGING state via the legal CONVERGING → CONVERGING self-loop.
        delib.transition(d.id, "CONVERGING", { synthesisHash: synth.reportHash }, { expectedVersion: fresh.version });
      }
      d = delib.loadDeliberation(d.id);
    }

    // 3d-pre. Slice C — human-nudge pause. If a nudge is configured for this
    // round AND we have not yet recorded one for it, mark the deliberation as
    // awaiting and exit the loop. Caller polls status; resume via the nudge
    // tool. Already-recorded nudges flow through unchanged.
    if (ctx.humanNudge && ctx.humanNudge.afterRound === round) {
      const already = Array.isArray(d.humanNudges)
        ? d.humanNudges.some((n: any) => n.afterRound === round)
        : false;
      if (!already) {
        const fresh = delib.loadDeliberation(d.id);
        try {
          delib.transition(d.id, "CONVERGING", {
            awaitingNudge: {
              afterRound: round,
              promptText: ctx.humanNudge.promptText,
              promptedAt: new Date().toISOString(),
            },
          }, { expectedVersion: fresh.version });
        } catch {}
        return {
          ...delib.loadDeliberation(d.id),
          _outcome: "awaiting_nudge",
          _awaitingNudge: { afterRound: round, promptText: ctx.humanNudge.promptText },
        };
      }
    }

    // 3d. Decide.
    const decision = delib.decide({ deliberation: d });

    // 3e. Apply.
    if (decision.action === "ADVANCE_ROUND") {
      // Anti-dropout-bias: thread current round's dissenters into reassemble.
      const prevDissenters = d.dissent
        .filter((x: any) => x.round === d.currentRound)
        .map((x: any) => x.profileId);
      // applyDecision would have transitioned to CONVERGING; reassembleCouncil
      // expects the source state to already BE CONVERGING. Drive both:
      //  1) bump currentRound via applyDecision (CONVERGING with currentRound+1)
      //  2) reassemble with previousDissenterProfileIds
      // OR: skip applyDecision and let reassembleCouncil do the round bump.
      // reassembleCouncil only accepts source=CONVERGING, and our current state
      // is CONVERGING, so call it directly.
      const reOutcome = await delib.reassembleCouncil({
        deliberationId: d.id,
        candidates,
        previousDissenterProfileIds: prevDissenters,
        expectedSourceState: "CONVERGING",
        deps: assembleDeps,
      });
      if (reOutcome.kind === "ESCALATED") {
        return buildEscalationResponse({
          delib: delib.loadDeliberation(d.id),
          outcome: "escalated_during_reassembly",
          reason: reOutcome.reason,
          details: reOutcome.details,
          verbose: ctx.verbose,
        });
      }
    } else {
      await delib.applyDecision(d.id, decision, { expectedVersion: d.version });
    }

    d = delib.loadDeliberation(d.id);
  }

  return { ...d, _outcome: String(d.state).toLowerCase() };
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberation_nudge — Slice C
//
// Resume a deliberation that paused waiting for human input. `response` is
// either a non-empty string (recorded as user input + injected into next-round
// voter prompts) or null/empty (recorded as "skip"; the loop resumes without
// changing prompts). Either way, the orchestration loop is re-driven inline.
// ─────────────────────────────────────────────────────────────────────────────
export interface DeliberationNudgeArgs {
  deliberationId: string;
  response: string | null;
  deps?: DeliberateDeps;
}

export async function deliberationNudgeHandler(args: DeliberationNudgeArgs): Promise<any> {
  if (!args || typeof args !== "object" || typeof args.deliberationId !== "string") {
    throw new Error("zana_deliberation_nudge: deliberationId is required");
  }
  const work = _work();
  const delib = _delib();
  const core = _core();

  const d = delib.loadDeliberation(args.deliberationId);
  if (!d) throw new Error(`zana_deliberation_nudge: deliberation not found: ${args.deliberationId}`);
  if (!d.awaitingNudge) {
    throw new Error(`zana_deliberation_nudge: deliberation ${args.deliberationId} is not awaiting a nudge`);
  }

  const responseText = typeof args.response === "string" ? args.response.trim() : "";
  let textHash: string | null = null;
  let contributedBy: "user" | "skip";
  if (responseText.length > 0) {
    const stored = work.runs.artifacts.storeContentAddressed(responseText);
    textHash = stored.hash;
    contributedBy = "user";
  } else {
    contributedBy = "skip";
  }

  delib.recordHumanNudge(
    args.deliberationId,
    { afterRound: d.awaitingNudge.afterRound, textHash, contributedBy },
    { expectedVersion: d.version },
  );

  // Re-drive the orchestration loop. Resolve candidates from the existing
  // voter list — profiles via the deps-or-default getProfile.
  const deps = args.deps ?? {};
  const getProfile = deps.getProfile ?? ((id: string) => core.agents.profileStore.getProfile(id));
  const fresh = delib.loadDeliberation(args.deliberationId);
  const candidates: { profileId: string; profile: any }[] = fresh.voters.map((v: any) => {
    const profile = getProfile(v.profileId) || getProfile(`built-in-${v.profileId}`);
    return { profileId: v.profileId, profile: profile ?? { id: v.profileId, model: v.modelId } };
  });

  const killAgent = deps.killAgent ?? ((id: string) => {
    try { return core.agents.manager.killAgent(id); } catch { return false; }
  });
  const activeRun: ActiveRun = {
    startedAt: Date.now(),
    cancelled: false,
    killAgent,
    liveAgentIds: new Set<string>(),
  };
  activeRuns.set(args.deliberationId, activeRun);

  const rt = delib.getRuntimeConfig();
  const escalationStrategy: "human" | "judge" | "hybrid" =
    (rt.escalationStrategy as "human" | "judge" | "hybrid" | undefined) ?? "human";

  // Reconstitute the original prompt snapshot from CAS so round-N voter
  // prompts contain the original question + any nudge addenda.
  let restoredPrompt = "";
  try {
    const buf = work.runs.artifacts.readContentAddressed(fresh.promptSnapshotHash);
    if (buf) restoredPrompt = String(buf);
  } catch {}
  if (restoredPrompt === "") {
    restoredPrompt = `# Deliberation\n\n## Question\n${fresh.question}\n`;
  }

  const ctx: RunDeliberationContext = {
    deliberationId: args.deliberationId,
    candidates,
    promptSnapshot: restoredPrompt,
    deps,
    rounds: fresh.rounds,
    getProfile,
    activeRun,
    escalationStrategy,
    humanNudge: null, // already-resumed run; nudge already recorded
    skipFirstCollectAndSynth: true,
    verbose: (args as any)?.verbose === true,
    skipProbe: (args as any)?.skipProbe === true,
  };

  try {
    return await runDeliberation(ctx);
  } finally {
    activeRuns.delete(args.deliberationId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberation_status
// ─────────────────────────────────────────────────────────────────────────────
export function deliberationStatusHandler(args: { deliberationId: string }): any {
  if (!args || typeof args.deliberationId !== "string" || args.deliberationId === "") {
    throw new Error("zana_deliberation_status: deliberationId is required");
  }
  const d = _delib().loadDeliberation(args.deliberationId);
  if (!d) throw new Error(`deliberation not found: ${args.deliberationId}`);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberation_list
// ─────────────────────────────────────────────────────────────────────────────
export function deliberationListHandler(args: { state?: string } = {}): any[] {
  const filter: any = {};
  if (typeof args?.state === "string" && args.state !== "") filter.state = args.state;
  const all = _delib().listDeliberations(filter);
  // Return summaries — the full record can be fetched by id via _status.
  // Truncate question to a snippet; full text lives in the per-id detail view
  // (a list of 30 deliberations × 2000-char questions overruns chat output).
  const Q_MAX = 140;
  return all.map((d: any) => {
    const q = typeof d.question === "string" ? d.question : "";
    const collapsed = q.replace(/\s+/g, " ").trim();
    const question = collapsed.length > Q_MAX ? collapsed.slice(0, Q_MAX - 1) + "…" : collapsed;
    return {
      id: d.id,
      state: d.state,
      question,
      currentRound: d.currentRound,
      rounds: d.rounds,
      voters: d.voters?.length ?? 0,
      verdict: d.verdict,
      escalationReason: d.escalationReason,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      settledAt: d.settledAt,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberation_override
// ─────────────────────────────────────────────────────────────────────────────
export interface OverrideArgs {
  deliberationId: string;
  decision: "approve" | "reject" | "rework";
  reason: string;
  humanId?: string;
  deps?: { storeContentAddressed?: (bytes: string | Buffer) => { hash: string } };
}

export function deliberationOverrideHandler(args: OverrideArgs): any {
  if (!args || typeof args !== "object") {
    throw new Error("zana_deliberation_override: args required");
  }
  if (typeof args.deliberationId !== "string" || args.deliberationId === "") {
    throw new Error("zana_deliberation_override: deliberationId is required");
  }
  if (args.decision !== "approve" && args.decision !== "reject" && args.decision !== "rework") {
    throw new Error(`zana_deliberation_override: invalid decision: ${String(args.decision)}`);
  }
  if (typeof args.reason !== "string" || args.reason.trim() === "") {
    throw new Error("zana_deliberation_override: reason is required");
  }
  const work = _work();
  const delib = _delib();
  const storeCAS = args.deps?.storeContentAddressed
    ?? ((bytes: string | Buffer) => work.runs.artifacts.storeContentAddressed(bytes));
  const stored = storeCAS(args.reason);

  const d = delib.loadDeliberation(args.deliberationId);
  if (!d) throw new Error(`deliberation not found: ${args.deliberationId}`);

  const updated = delib.recordOverride(args.deliberationId, {
    humanId: args.humanId || "human",
    decision: args.decision,
    reasonHash: stored.hash,
    ts: new Date().toISOString(),
  }, { expectedVersion: d.version });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberate_cancel
//
// Cancel a running deliberation. Pairs with the async-by-default deliberate
// tool — without it, a stuck or wrongly-scoped run would burn voter budget
// until the per-voter timeout fires for every round.
//
// Behavior:
//   1. Look up the activeRuns entry. If none, the run already completed
//      (or never registered) — return the current persisted record.
//   2. Set the cancelled flag so the next checkCancelled() in the loop
//      throws DeliberationCancelledError.
//   3. Kill any voter agents we registered via trackedSpawn — this unblocks
//      collectReviews polling immediately.
//   4. Return the current deliberation record. Final EXHAUSTED state lands
//      shortly after via the runner's catch handler; callers polling
//      zana_deliberation_status will see it.
// ─────────────────────────────────────────────────────────────────────────────
export interface CancelArgs {
  deliberationId: string;
}

export function deliberationCancelHandler(args: CancelArgs): any {
  if (!args || typeof args.deliberationId !== "string" || args.deliberationId === "") {
    throw new Error("zana_deliberate_cancel: deliberationId is required");
  }
  const delib = _delib();
  const d = delib.loadDeliberation(args.deliberationId);
  if (!d) throw new Error(`deliberation not found: ${args.deliberationId}`);

  // Already terminal — no-op, return the record.
  if (d.state === "SETTLED" || d.state === "ESCALATED" || d.state === "EXHAUSTED") {
    return { ...d, _outcome: "already_terminal", _alreadyTerminal: true };
  }

  const active = activeRuns.get(args.deliberationId);
  if (!active) {
    // Not tracked in this process — best-effort: drive the deliberation to
    // EXHAUSTED if state allows, otherwise ESCALATED via the override path.
    // (Cross-process cancel is a future feature; for now warn via _orphan.)
    try {
      delib.transition(args.deliberationId, "EXHAUSTED", {}, { expectedVersion: d.version });
    } catch {
      try {
        delib.transition(args.deliberationId, "ESCALATED", { escalationReason: "explicit" }, { expectedVersion: d.version });
      } catch {}
    }
    const after = delib.loadDeliberation(args.deliberationId);
    return { ...after, _outcome: "cancelled", _orphan: true };
  }

  // Tracked — flip the kill switch and terminate any spawned voters.
  active.cancelled = true;
  let killed = 0;
  for (const agentId of active.liveAgentIds) {
    try {
      if (active.killAgent(agentId)) killed++;
    } catch {}
  }
  active.liveAgentIds.clear();

  return {
    ...delib.loadDeliberation(args.deliberationId),
    _outcome: "cancelling",
    _killedAgents: killed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP tool definitions — registered in mcp-server.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const deliberateTool = {
  name: "zana_deliberate",
  description:
    "Start a multi-voice deliberation: parallel review → synthesis → up-to-N convergence rounds → settle or escalate. " +
    "Each voter is an independent agent with its own profile/model. Dissent is preserved verbatim across EVERY round. " +
    "Default behavior: returns IMMEDIATELY with the proposed deliberation record (state=PROPOSED, _outcome='running'). " +
    "Real-Claude voters can take 5-10 min each; the orchestration loop runs detached on the daemon. " +
    "Poll `zana_deliberation_status({deliberationId})` until state is SETTLED or ESCALATED. " +
    "Pass `wait: true` to block until completion (legacy / scripted use). " +
    "When complete, the deliberation record carries: " +
    "`_outcome` — 'settled' | 'escalated' | 'escalated_at_assembly' | 'escalated_during_reassembly' | 'judged'. " +
    "`_judge` — present only on 'judged'; { verdict, humanId } describing how the auto-judge resolved an escalation. " +
    "`_judgeError` — present only when the configured strategy was judge/hybrid but adjudication failed; deliberation stays ESCALATED for manual override. " +
    "`_assemblyEscalation` — present only on 'escalated_at_assembly'; { reason, details, voterFailures, nextSteps } naming each dropped voter and the typed probe-failure kind (timeout/auth/validation/misconfig/rate_limit/quota/transport/spawn). Surface voterFailures[] and nextSteps verbatim to the user. " +
    "`_reassemblyEscalation` — present only on 'escalated_during_reassembly'; same shape as _assemblyEscalation, describing why a subsequent round's council failed.",
  inputSchema: {
    type: "object",
    required: ["question"],
    properties: {
      question: { type: "string", description: "What the council is deliberating on." },
      voters: {
        anyOf: [
          {
            type: "array",
            items: { type: "string" },
            description: "Explicit voter profile IDs.",
          },
          {
            type: "object",
            required: ["pack"],
            properties: {
              pack: {
                type: "string",
                enum: ["arch", "code-review", "plan", "review"],
                description: "Role-pack id; resolves to a deterministic voter list.",
              },
              quantity: {
                type: "number",
                description: "Number of voter slots to fill from the pack ladder. Default 3.",
              },
            },
          },
        ],
        description:
          "Voters to convene. Either an explicit profile-id array OR a named role pack { pack, quantity? }. " +
          "Defaults to ['architect','security-reviewer','researcher'] when omitted.",
      },
      rounds: { type: "number", description: "Hard cap on convergence rounds (default from module config)." },
      quorum: {
        anyOf: [{ type: "string" }, { type: "number" }],
        description: "majority | all | <integer>. Default from module config.",
      },
      mode: {
        type: "string",
        enum: ["synthesis", "tally"],
        description: "Reduction mode (default from module config).",
      },
      riskTag: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "high → mandatory escalation regardless of vote (default 'medium').",
      },
      context: {
        type: "array",
        items: { type: "string" },
        description: "Optional artifact IDs to seed context. Each is read and embedded in the shared prompt.",
      },
      wait: {
        type: "boolean",
        description: "If true, block until the deliberation reaches a terminal state. Default false (async).",
      },
      escalationStrategy: {
        type: "string",
        enum: ["human", "judge", "hybrid"],
        description:
          "Override the deliberation module's escalationStrategy for this call. " +
          "'judge' / 'hybrid' auto-resolve a non-high-risk ESCALATED outcome by spawning a judge agent that reads the transcript and emits a verdict. " +
          "'human' leaves the deliberation ESCALATED so an operator can call zana_deliberation_override. " +
          "riskTag='high' always escalates to a human regardless of this setting.",
      },
      voterModels: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Per-voter model override: { profileId → modelId }. Replaces the profile's declared model for this deliberation only. Each model must be in the local registry.",
      },
      modelDiversity: {
        type: "string",
        enum: ["uniform", "mixed"],
        description:
          "uniform (default) — every voter uses its profile's declared model. mixed — rotate through {claude-sonnet-4-6, claude-haiku-4-5, claude-opus-4-7} for monoculture-resistance. Per-voter overrides in voterModels still win over the rotation.",
      },
      humanNudge: {
        oneOf: [
          { type: "boolean", enum: [false] },
          {
            type: "object",
            required: ["afterRound"],
            properties: {
              afterRound: { type: "number", description: "Round number after which to pause for human input." },
              promptText: { type: "string", description: "Optional prompt shown to the operator." },
            },
          },
        ],
        description:
          "Pause the loop after synthesizing the named round and exit with _outcome='awaiting_nudge'. " +
          "Resume via zana_deliberation_nudge with either a free-text response (injected into next round) or null/empty (skip).",
      },
      verbose: {
        type: "boolean",
        description:
          "Reserved for future use. The escalation response always includes the full deliberation record plus voterFailures[]/nextSteps in _assemblyEscalation / _reassemblyEscalation; this flag is currently a no-op.",
      },
      skipProbe: {
        type: "boolean",
        description:
          "Bypass the capability-probe gate. Use for low-stakes / brainstorm flows where probe latency (3 spawns × N voters) outweighs the value of catching a broken voter early. If a voter is genuinely broken, the failure surfaces during the collect-reviews round instead of at probe time. Default false (probes run as today).",
      },
    },
  },
};

export const deliberationNudgeTool = {
  name: "zana_deliberation_nudge",
  description:
    "Resume a paused deliberation by recording an optional human reviewer note. " +
    "Pass `response` as a non-empty string to inject the text verbatim into the next round's voter prompts (recorded with contributedBy='user'). " +
    "Pass null or an empty string to record a 'skip' and continue without changing prompts. " +
    "Errors if the deliberation is not currently awaiting a nudge.",
  inputSchema: {
    type: "object",
    required: ["deliberationId"],
    properties: {
      deliberationId: { type: "string" },
      response: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "Free-text human note. null or empty string = skip.",
      },
    },
  },
};

export const deliberationStatusTool = {
  name: "zana_deliberation_status",
  description: "Load a deliberation by id and return its full state record.",
  inputSchema: {
    type: "object",
    required: ["deliberationId"],
    properties: {
      deliberationId: { type: "string" },
    },
  },
};

export const deliberationListTool = {
  name: "zana_deliberation_list",
  description: "List deliberation summaries, optionally filtered by state.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: ["PROPOSED", "REVIEWING", "SYNTHESIZING", "CONVERGING", "SETTLED", "ESCALATED", "EXHAUSTED"],
        description: "Filter by deliberation state. Omit to list all.",
      },
    },
  },
};

export const deliberationOverrideTool = {
  name: "zana_deliberation_override",
  description:
    "Record a human override on a deliberation. Stores the reason in the content-addressed artifact store and " +
    "stamps the reasonHash onto the deliberation. Lands the deliberation on SETTLED.",
  inputSchema: {
    type: "object",
    required: ["deliberationId", "decision", "reason"],
    properties: {
      deliberationId: { type: "string" },
      decision: { type: "string", enum: ["approve", "reject", "rework"] },
      reason: { type: "string" },
      humanId: { type: "string", description: "Optional human id. Defaults to 'human'." },
    },
  },
};

export const deliberationCancelTool = {
  name: "zana_deliberate_cancel",
  description:
    "Cancel a running deliberation. Flips the kill switch on the in-process orchestration loop, terminates any spawned voter agents, " +
    "and drives the deliberation toward EXHAUSTED. Returns immediately; the EXHAUSTED transition lands shortly after via the runner's " +
    "cancellation handler. " +
    "If the deliberation is already terminal (SETTLED/ESCALATED/EXHAUSTED), returns _alreadyTerminal=true with no mutation. " +
    "If the run isn't tracked in this process (e.g. daemon restarted), best-effort transitions to EXHAUSTED and returns _orphan=true. " +
    "Result includes `_outcome` ('cancelling' | 'already_terminal' | 'cancelled') and, for live cancels, `_killedAgents` count.",
  inputSchema: {
    type: "object",
    required: ["deliberationId"],
    properties: {
      deliberationId: { type: "string" },
    },
  },
};

// Used by mcp-server.ts to assemble the static TOOLS list.
export const DELIBERATION_TOOLS = [
  deliberateTool,
  deliberationStatusTool,
  deliberationListTool,
  deliberationOverrideTool,
  deliberationCancelTool,
  deliberationNudgeTool,
];

// Re-export the collected-review type for tests.
export type { CollectedReview };
