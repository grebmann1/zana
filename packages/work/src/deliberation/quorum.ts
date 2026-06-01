// Quorum + graceful-degradation — T6
//
// Assembles a council of voters for a PROPOSED deliberation by smoke-probing
// each candidate (via @zana-ai/core probeAgent), applying quorum rules, and
// transitioning the deliberation to REVIEWING (with the resolved Voter[]) or
// ESCALATED (when quorum cannot be met or governance forbids it).
//
// Why this matters (governance):
//   - Without quorum gating, a 5-voter council where 4 are unreachable would
//     proceed with 1 voice = dictatorship laundered through council framing.
//   - Without anti-dropout-bias, a malicious actor could selectively drop a
//     dissenter to flip an adversarial outcome.
//   - Probe failures use FU-T3a typed `ProbeFailure.kind` so future tickets
//     (T9) can distinguish transient (timeout) from structural (misconfig)
//     failures and choose retry vs. escalate. Sprint 2 v1: ANY failure drops.
//
// T6 owns voter assembly only. It does NOT spawn the actual review work —
// that's T9 / round controller territory.

import * as crypto from "node:crypto";

import type { Deliberation, DeliberationState, Voter } from "./types";
import {
  loadDeliberation,
  transition,
  StaleDeliberationError,
} from "./run";
import { getRuntimeConfig } from "./runtime-config";

// Lazy-load @zana-ai/core to dodge module init cycles (matches the pattern in
// run.ts). We need probeAgent + the typed ProbeFailure surface from FU-T3a.
function _core(): any { return require("@zana-ai/core"); }
function _probeAgent(): any { return _core().agents.manager.probeAgent; }

// Mirror the probe-failure shape from packages/core/src/events/deliberation-events.ts.
// Re-declared here as a type alias to avoid a hard import edge that would force
// the work package to compile against core's types eagerly.
// FU-T3a-3 — keep this in lockstep with the core union (split spawn into typed
// retry-policy buckets).
export type ProbeFailureKind =
  | "timeout"
  | "validation"
  | "misconfig"
  | "auth"
  | "rate_limit"
  | "quota"
  | "transport"
  | "spawn";
export interface ProbeFailure {
  leg: "factual" | "instructionFollowing" | "toolUse" | null;
  kind: ProbeFailureKind;
  reason: string;
  raw?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface VoterCandidate {
  profileId: string;
  // Caller-resolved profile object — quorum.ts does not load profiles itself.
  profile: any;
}

export interface AssembleDeps {
  // Allow injecting a fake probeAgent for tests. Defaults to @zana-ai/core's.
  probeAgent?: (profile: any, probe?: any, deps?: any) => Promise<any>;
  spawnHeadlessAgent?: any;
  getAgent?: any;
  killAgent?: any;
}

export interface AssembleInput {
  deliberationId: string;          // already PROPOSED via run.propose()
  candidates: VoterCandidate[];
  // Anti-dropout-bias context (T9 will pass this when re-assembling between
  // convergence rounds). Sprint 2 callers pass undefined or [].
  previousDissenterProfileIds?: string[];
  deps?: AssembleDeps;
}

export interface DroppedVoter {
  profileId: string;
  reason: ProbeFailureKind;
  detail: string;
}

export type AssembleEscalationReason =
  | "quorum_lost"
  | "dropout_was_dissenter"
  | "all_probes_failed";

export type AssembleOutcome =
  | { kind: "READY"; voters: Voter[]; degraded: { dropped: DroppedVoter[] } }
  | { kind: "ESCALATED"; reason: AssembleEscalationReason; details: string };

export interface DegradationContext {
  candidateCount: number;
  quorum: number;
  // Profile IDs of the previous round's dissenters. If any of them appears in
  // the dropped set, the deliberation MUST escalate (anti-dropout-bias).
  previousDissenterProfileIds?: string[];
}

export interface DegradationDecision {
  decision: "READY" | "ESCALATED";
  reason?: AssembleEscalationReason;
  rationale: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveQuorum — number | "majority" | "all" → integer
// ─────────────────────────────────────────────────────────────────────────────
export function resolveQuorum(
  spec: number | "majority" | "all",
  n: number,
): number {
  const candidateCount = Math.max(0, Math.floor(n));
  if (spec === "majority") {
    if (candidateCount === 0) return 1; // can't make majority of 0; clamp up.
    return Math.floor(candidateCount / 2) + 1;
  }
  if (spec === "all") {
    return Math.max(1, candidateCount);
  }
  if (typeof spec === "number" && Number.isFinite(spec)) {
    const q = Math.floor(spec);
    if (candidateCount === 0) return Math.max(1, q);
    // Clamp to [1, candidateCount]: requesting quorum > N is just N (so the
    // ESCALATED path will fire anyway when probes drop people).
    return Math.min(candidateCount, Math.max(1, q));
  }
  throw new Error(`resolveQuorum: invalid spec ${String(spec)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// applyDegradation — pure function deciding READY vs ESCALATED
//
// Order of checks matters:
//   1. Anti-dropout-bias FIRST. If a dropped voter was a previous dissenter,
//      we escalate even if quorum still holds. Suppressing the minority voice
//      is the failure mode this rule exists to prevent.
//   2. all_probes_failed (no successful voters AND at least one drop).
//   3. quorum_lost (not enough successful voters).
//   4. READY otherwise.
// ─────────────────────────────────────────────────────────────────────────────
export function applyDegradation(
  successfulVoters: Voter[],
  droppedVoters: DroppedVoter[],
  ctx: DegradationContext,
): DegradationDecision {
  const prevDissenters = Array.isArray(ctx.previousDissenterProfileIds)
    ? ctx.previousDissenterProfileIds
    : [];

  if (prevDissenters.length > 0 && droppedVoters.length > 0) {
    const droppedDissenter = droppedVoters.find((d) =>
      prevDissenters.includes(d.profileId),
    );
    if (droppedDissenter) {
      return {
        decision: "ESCALATED",
        reason: "dropout_was_dissenter",
        rationale:
          `dropped voter profile=${droppedDissenter.profileId} was a dissenter ` +
          `in the previous round; anti-dropout-bias rule forbids proceeding`,
      };
    }
  }

  if (successfulVoters.length === 0 && droppedVoters.length > 0) {
    return {
      decision: "ESCALATED",
      reason: "all_probes_failed",
      rationale: `all ${droppedVoters.length} candidate probes failed`,
    };
  }

  if (successfulVoters.length < ctx.quorum) {
    return {
      decision: "ESCALATED",
      reason: "quorum_lost",
      rationale:
        `only ${successfulVoters.length} of ${ctx.candidateCount} candidates ` +
        `passed probe; quorum=${ctx.quorum}`,
    };
  }

  return {
    decision: "READY",
    rationale:
      droppedVoters.length === 0
        ? `all ${successfulVoters.length} candidates probed OK`
        : `${successfulVoters.length} of ${ctx.candidateCount} candidates probed OK ` +
          `(${droppedVoters.length} dropped); quorum=${ctx.quorum} met`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// assembleCouncil — main entry point
// ─────────────────────────────────────────────────────────────────────────────

// Hard-coded fallback when runtime-config is unavailable (defensive — runtime
// config always carries a default, but keeping the const documents the wire-in).
const MAX_STALE_RETRIES_FALLBACK = 3;

interface ProbePass {
  voters: Voter[];
  dropped: DroppedVoter[];
}

async function runProbes(
  candidates: VoterCandidate[],
  deps: AssembleDeps,
): Promise<ProbePass> {
  const probeFn = deps.probeAgent ?? _probeAgent();
  const probeDeps: any = {};
  if (deps.spawnHeadlessAgent) probeDeps.spawnHeadlessAgent = deps.spawnHeadlessAgent;
  if (deps.getAgent) probeDeps.getAgent = deps.getAgent;
  if (deps.killAgent) probeDeps.killAgent = deps.killAgent;

  // Promise.allSettled so one hung probe (or thrown handler) doesn't block
  // the rest. We handle each settle outcome explicitly below.
  const settled = await Promise.allSettled(
    candidates.map((c) => probeFn(c.profile, undefined, probeDeps)),
  );

  const voters: Voter[] = [];
  const dropped: DroppedVoter[] = [];

  for (let i = 0; i < settled.length; i++) {
    const c = candidates[i];
    const s = settled[i];

    if (s.status === "rejected") {
      // The probe itself threw — treat as a spawn-class failure so the
      // dropped reason is structural, not silent.
      dropped.push({
        profileId: c.profileId,
        reason: "spawn",
        detail: `probe threw: ${(s.reason && s.reason.message) || String(s.reason)}`,
      });
      continue;
    }

    const result = s.value;
    if (result && result.ok === true) {
      voters.push({
        agentId: crypto.randomUUID(),
        profileId: c.profileId,
        // Audit: actual model used is what landed in probeResult.modelId — not
        // the profile's declared model verbatim. probeAgent already pins this
        // from the declared model under the Sprint-2 contract, but keeping the
        // indirection right means future model-routing changes are recorded.
        modelId:
          typeof result.modelId === "string" && result.modelId.length > 0
            ? result.modelId
            : (c.profile?.model ?? "unknown"),
      });
    } else {
      const failures: ProbeFailure[] = Array.isArray(result?.failures)
        ? result.failures
        : [];
      const first = failures[0];
      const detail =
        failures.length === 0
          ? "probe returned ok=false with no failures"
          : failures.map((f) => `${f.leg ?? "*"}:${f.kind}:${f.reason}`).join("; ");
      dropped.push({
        profileId: c.profileId,
        reason: first?.kind ?? "validation",
        detail,
      });
    }
  }

  return { voters, dropped };
}

// ─────────────────────────────────────────────────────────────────────────────
// reassembleCouncil — between-round re-spawn (T6-FU-1)
//
// T9 needs to re-assemble voters between convergence rounds when decide()
// returns ADVANCE_ROUND. At that point:
//   - state is REVIEWING or CONVERGING, NOT PROPOSED;
//   - some round-N voters may have dropped out;
//   - previousDissenterProfileIds must be threaded so applyDegradation's
//     anti-dropout-bias rule fires when a dissenter is among the dropouts.
//
// Shared probe/quorum/degradation machinery lives in `assembleCore` below;
// this function is a thin wrapper that pins the source/target states and the
// round-increment behavior.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReassembleInput {
  deliberationId: string;
  candidates: VoterCandidate[];
  // Voters who voted CHANGES (or otherwise dissented) in the previous round.
  // The anti-dropout-bias rule will escalate the deliberation if any of these
  // profileIds appears in the dropped set after re-probe.
  previousDissenterProfileIds: string[];
  // Reassembly is only legal from CONVERGING (we just closed a convergence
  // round). PROPOSED → use assembleCouncil. REVIEWING → finish synthesis first;
  // the T5 transition table forbids REVIEWING → CONVERGING (must go through
  // SYNTHESIZING). Accepting REVIEWING here would always crash at the legal-
  // transition guard, so we reject at the input boundary with a clear message.
  expectedSourceState: "CONVERGING";
  deps?: AssembleDeps;
}

export type ReassembleOutcome = AssembleOutcome;

export async function reassembleCouncil(
  input: ReassembleInput,
): Promise<ReassembleOutcome> {
  if (!input || typeof input !== "object") {
    throw new Error("reassembleCouncil: input is required");
  }
  if (typeof input.deliberationId !== "string" || input.deliberationId === "") {
    throw new Error("reassembleCouncil: deliberationId is required");
  }
  if (!Array.isArray(input.candidates)) {
    throw new Error("reassembleCouncil: candidates must be an array");
  }
  if (!Array.isArray(input.previousDissenterProfileIds)) {
    throw new Error(
      "reassembleCouncil: previousDissenterProfileIds must be an array (use [] when none)",
    );
  }
  if (input.expectedSourceState !== "CONVERGING") {
    throw new Error(
      `reassembleCouncil: expectedSourceState must be "CONVERGING", got ${String(
        input.expectedSourceState,
      )}. Reassembling from REVIEWING is illegal (must go through SYNTHESIZING first per the T5 state machine); for the initial assembly use assembleCouncil instead.`,
    );
  }

  validateCandidates(input.candidates, "reassembleCouncil");

  return assembleCore(
    "reassembleCouncil",
    input.deliberationId,
    input.candidates,
    {
      expectedSourceState: input.expectedSourceState,
      targetState: "CONVERGING",
      previousDissenterProfileIds: input.previousDissenterProfileIds,
      incrementRound: true,
    },
    input.deps ?? {},
  );
}

export async function assembleCouncil(
  input: AssembleInput,
): Promise<AssembleOutcome> {
  if (!input || typeof input !== "object") {
    throw new Error("assembleCouncil: input is required");
  }
  if (typeof input.deliberationId !== "string" || input.deliberationId === "") {
    throw new Error("assembleCouncil: deliberationId is required");
  }
  if (!Array.isArray(input.candidates)) {
    throw new Error("assembleCouncil: candidates must be an array");
  }

  validateCandidates(input.candidates, "assembleCouncil");

  return assembleCore(
    "assembleCouncil",
    input.deliberationId,
    input.candidates,
    {
      expectedSourceState: "PROPOSED",
      targetState: "REVIEWING",
      previousDissenterProfileIds: input.previousDissenterProfileIds ?? [],
      incrementRound: false,
    },
    input.deps ?? {},
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// validateCandidates — shared input-validation for assemble + reassemble.
// Loud rejection of duplicate profileIds (silent dedupe would hide a caller bug).
// ─────────────────────────────────────────────────────────────────────────────
function validateCandidates(candidates: VoterCandidate[], fnName: string): void {
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c || typeof c.profileId !== "string") {
      throw new Error(`${fnName}: every candidate must carry a profileId`);
    }
    if (seen.has(c.profileId)) {
      throw new Error(`${fnName}: duplicate candidate profileId=${c.profileId}`);
    }
    seen.add(c.profileId);
  }
}

interface AssembleCoreContext {
  expectedSourceState: DeliberationState;
  targetState: "REVIEWING" | "CONVERGING";
  previousDissenterProfileIds: string[];
  // Initial assemble (PROPOSED → REVIEWING) leaves currentRound alone (it is
  // bumped to 1 by the synthesis-driven CONVERGING transition). Reassemble
  // (REVIEWING|CONVERGING → CONVERGING) opens the next round, so we bump.
  incrementRound: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// assembleCore — shared probe / degrade / transition pipeline.
//
// Both assembleCouncil and reassembleCouncil delegate here. Differences are
// encoded in `ctx`:
//   - which source state to assert,
//   - which destination state to transition to on READY,
//   - whether to bump currentRound,
//   - which previousDissenterProfileIds to thread into applyDegradation.
// ─────────────────────────────────────────────────────────────────────────────
async function assembleCore(
  fnName: string,
  deliberationId: string,
  candidates: VoterCandidate[],
  ctx: AssembleCoreContext,
  deps: AssembleDeps,
): Promise<AssembleOutcome> {
  // ──────────────────────────────────────────────────────────────────────────
  // Retry loop for StaleDeliberationError. Between probe and transition, a
  // concurrent caller could advance the deliberation. On stale, we reload,
  // re-probe, and retry up to N.
  //
  // Read the retry budget ONCE at function entry — config changes mid-loop
  // would otherwise change the loop bound under us and make tests flaky.
  // ──────────────────────────────────────────────────────────────────────────
  const occMaxRetries = (() => {
    const v = getRuntimeConfig().occMaxRetries;
    return typeof v === "number" && v >= 0 ? Math.floor(v) : MAX_STALE_RETRIES_FALLBACK;
  })();
  let lastError: any = null;
  for (let attempt = 0; attempt < occMaxRetries; attempt++) {
    const d = loadDeliberation(deliberationId);
    if (!d) {
      throw new Error(`${fnName}: deliberation not found: ${deliberationId}`);
    }
    if (d.state !== ctx.expectedSourceState) {
      throw new Error(
        `${fnName}: expected state ${ctx.expectedSourceState}, found ${d.state}`,
      );
    }

    const expectedVersion = d.version;

    // Probe all candidates in parallel.
    const { voters, dropped } = await runProbes(candidates, deps);

    // Resolve the runtime quorum based on the candidate count. The quorum
    // recorded at propose() time was a placeholder against the spec count; we
    // recompute here in case future callers pass a different candidate set.
    const quorum = d.quorum > 0 ? d.quorum : resolveQuorum("majority", candidates.length);

    const decision = applyDegradation(voters, dropped, {
      candidateCount: candidates.length,
      quorum,
      previousDissenterProfileIds: ctx.previousDissenterProfileIds,
    });

    try {
      if (decision.decision === "READY") {
        const patch: any = { voters };
        if (ctx.incrementRound) {
          patch.currentRound = d.currentRound + 1;
        }
        // T6-FU-3 — when ANY voter dropped, append a degradation entry to
        // the persisted audit trail. The round we record is the round that
        // is about to begin: post-increment for reassemble (CONVERGING →
        // CONVERGING bumps round), and the existing currentRound for the
        // initial assemble (PROPOSED → REVIEWING does not bump round; T5
        // bumps to 1 at SYNTHESIZING → CONVERGING).
        const degradationEntry = dropped.length > 0
          ? {
              round: ctx.incrementRound ? d.currentRound + 1 : d.currentRound,
              dropped: dropped.map((dv) => ({
                profileId: dv.profileId,
                reason: dv.reason,
                detail: dv.detail,
              })),
              ts: new Date().toISOString(),
            }
          : null;
        if (degradationEntry) {
          patch.degradation = [
            ...(Array.isArray(d.degradation) ? d.degradation : []),
            degradationEntry,
          ];
        }
        transition(
          deliberationId,
          ctx.targetState,
          patch,
          { expectedVersion },
        );
        // Emit deliberation:degraded *after* the transition lands, mirroring
        // the pattern used by other deliberation events (post-persist).
        if (degradationEntry) {
          try {
            const core = require("@zana-ai/core");
            const bus = core.events.bus;
            const EVENTS = core.events.EVENTS;
            bus.emit(EVENTS.DELIBERATION_DEGRADED, {
              deliberationId,
              round: degradationEntry.round,
              dropped: degradationEntry.dropped,
              ts: degradationEntry.ts,
            });
          } catch {}
        }
        return {
          kind: "READY",
          voters,
          degraded: { dropped },
        };
      }

      // ESCALATED path.
      transition(
        deliberationId,
        "ESCALATED",
        { escalationReason: decision.reason },
        { expectedVersion },
      );
      return {
        kind: "ESCALATED",
        reason: decision.reason!,
        details: decision.rationale,
      };
    } catch (err) {
      if (err instanceof StaleDeliberationError) {
        // Reload + re-probe + retry. We do NOT cache the probe results — the
        // delay between attempts is real enough that re-probing is the safer
        // (and more honest) move. T9 may add caching later when retry budgets
        // get tight.
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `${fnName}: gave up after ${occMaxRetries} stale-retry attempts: ` +
      (lastError?.message || "unknown stale error"),
  );
}
