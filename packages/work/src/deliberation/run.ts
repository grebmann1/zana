// Deliberation state machine — T5
//
// Pure-ish transitions: no agent spawning, no synthesis, no round driving.
// Sprint 2 tickets T6/T7/T8 layer those side-effects on top of this skeleton.
//
// Persistence: each deliberation is one checkpoint record (kind="deliberation")
// keyed by its uuid. Lifetime is 7 days.
//
// Concurrency model (T5a + T5x-cross-proc):
//   - StaleDeliberationError below catches the IN-PROCESS race: two callers
//     in the same Node process that each load v=N. The OCC version check on
//     persist() forces the loser to retry.
//   - Cross-PROCESS safety (two daemons / a CLI alongside an MCP server hitting
//     the same workspace) is provided by checkpoint/store.ts, which does
//     atomic write-tmp + rename plus a per-checkpoint advisory lockfile around
//     read-modify-write. The lockfile is best-effort; it is NOT a kernel-grade
//     fcntl lock and does not protect multi-machine NFS scenarios.
//   - Net: in-process collisions surface as StaleDeliberationError; cross-
//     process collisions either serialize cleanly via the lockfile or surface
//     as a contention error within a bounded budget (~500ms).
//
// Event semantics — what `transition()` emits, by destination state:
//   REVIEWING     → (no event; PROPOSED already fired the proposed event)
//   SYNTHESIZING  → deliberation:synthesis  (only if synthesisHash is now set)
//   CONVERGING    → (no dedicated event; round bumps are observed via votes)
//   SETTLED       → deliberation:converged  (only if verdict is now set)
//   ESCALATED     → deliberation:escalated
//   EXHAUSTED     → (no event)
//
// recordVote / recordOverride emit their own events; recordDissent does not
// (dissent is preserved verbatim into synthesis, which then fires synthesis
// at the SYNTHESIZING transition).

import * as crypto from "node:crypto";

import * as checkpointStore from "../runs/checkpoint/store";
import * as artifactStore from "../runs/artifact-store";
import { getRuntimeConfig } from "./runtime-config";

import type {
  Deliberation,
  DeliberationState,
  Dissent,
  EscalationReason,
  Mode,
  Override,
  RiskTag,
  Vote,
  Voter,
} from "./types";

// Lazy require for @zana-ai/core to dodge cyclic load order at module init.
function _core(): any { return require("@zana-ai/core"); }
function _bus(): any { return _core().events.bus; }
function _EVENTS(): any { return _core().events.EVENTS; }

const CHECKPOINT_KIND = "deliberation";

// ─────────────────────────────────────────────────────────────────────────────
// Optimistic concurrency (T5a)
//
// Every persist() bumps `d.version`. Mutation helpers accept an optional
// `expectedVersion` — when present, we assert the loaded record matches before
// mutating. T6 spawns voters in parallel; without this, two callers that each
// load v=N would both call recordVote and the loser silently overwrites the
// winner's append. With `expectedVersion`, the loser throws and retries.
// ─────────────────────────────────────────────────────────────────────────────
export class StaleDeliberationError extends Error {
  code = "STALE_DELIBERATION" as const;
  expected: number;
  actual: number;
  deliberationId: string;
  constructor(deliberationId: string, expected: number, actual: number) {
    super(
      `stale deliberation ${deliberationId}: expected version ${expected}, found ${actual}`,
    );
    this.name = "StaleDeliberationError";
    this.deliberationId = deliberationId;
    this.expected = expected;
    this.actual = actual;
  }
}

function assertVersion(d: Deliberation, expectedVersion: number | undefined): void {
  if (expectedVersion === undefined) return;
  if (d.version !== expectedVersion) {
    throw new StaleDeliberationError(d.id, expectedVersion, d.version);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// transition() patch allowlist (T5b)
//
// Only these fields may be passed in the `patch` arg to transition(). Anything
// else throws — silently dropping unknown keys is an audit hazard.
//
// `id`, `votes`, `dissent`, `override`, `state`, `createdAt`, `version`,
// `updatedAt`, `settledAt`, `promptSnapshotHash` are NEVER mutable via patch:
// they are immutable, have dedicated setters (recordVote/Dissent/Override),
// or are managed by the state machine itself.
// ─────────────────────────────────────────────────────────────────────────────
const PATCHABLE_FIELDS = new Set<keyof Deliberation>([
  "voters",
  "currentRound",
  "synthesisHash",
  "verdict",
  "escalationReason",
  "settledAt",
  "context",
  "riskTag",
  "quorum",
  "rounds",
  "mode",
  // T6-FU-3 — degradation is append-only; quorum.ts builds the new array
  // (existing entries + new entry) and passes it through here.
  "degradation",
  "verdictSource",
  // Slice C — append-only humanNudges audit + ephemeral awaitingNudge marker.
  "humanNudges",
  "awaitingNudge",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Legal transitions
//
// PROPOSED      → REVIEWING | EXHAUSTED (cancel)
// REVIEWING     → SYNTHESIZING | ESCALATED
// SYNTHESIZING  → CONVERGING | ESCALATED
// CONVERGING    → SETTLED | CONVERGING (next round) | ESCALATED | EXHAUSTED
// SETTLED       → terminal (override is recorded WITHOUT changing state)
// ESCALATED     → SETTLED (when human overrides) | terminal otherwise
// EXHAUSTED     → terminal
// ─────────────────────────────────────────────────────────────────────────────
export const TRANSITIONS: Record<DeliberationState, DeliberationState[]> = {
  // T6 — PROPOSED → ESCALATED is the "council failed to convene" path
  // (quorum_lost, all_probes_failed, dropout_was_dissenter on re-assembly).
  PROPOSED:     ["REVIEWING", "EXHAUSTED", "ESCALATED"],
  REVIEWING:    ["SYNTHESIZING", "ESCALATED"],
  SYNTHESIZING: ["CONVERGING", "ESCALATED"],
  CONVERGING:   ["SETTLED", "CONVERGING", "ESCALATED", "EXHAUSTED"],
  SETTLED:      [],
  ESCALATED:    ["SETTLED"],
  EXHAUSTED:    [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function persist(d: Deliberation, expiresAt?: number): Deliberation {
  // T5a — bump version immediately before save. Done here (not at call sites)
  // so every persistence path is covered uniformly. propose() seeds version
  // at -1 so the first persist lands the deliberation at version=0.
  d.version = (typeof d.version === "number" ? d.version : -1) + 1;
  d.updatedAt = nowIso();
  const cp: any = {
    id: d.id,
    kind: CHECKPOINT_KIND,
    deliberation: d,
  };
  if (typeof expiresAt === "number") {
    cp.expiresAt = expiresAt;
  } else {
    // Preserve any pre-existing expiresAt set by propose().
    const prior = checkpointStore.load(d.id);
    if (prior && typeof prior.expiresAt === "number") cp.expiresAt = prior.expiresAt;
  }
  checkpointStore.save(cp);
  return d;
}

function readFromCheckpoint(id: string): Deliberation | null {
  const cp = checkpointStore.load(id);
  if (!cp || cp.kind !== CHECKPOINT_KIND || !cp.deliberation) return null;
  return cp.deliberation as Deliberation;
}

function mustLoad(id: string): Deliberation {
  const d = readFromCheckpoint(id);
  if (!d) throw new Error(`deliberation not found: ${id}`);
  return d;
}

function resolveQuorum(spec: number | "majority" | "all" | undefined, voterCount: number): number {
  // Voter count may be 0 at propose() time — voters are resolved later by T6.
  // We still return an integer; quorum is recomputed by T6 once voters land.
  if (spec === undefined || spec === "majority") {
    return Math.max(1, Math.floor(voterCount / 2) + 1);
  }
  if (spec === "all") {
    return Math.max(1, voterCount);
  }
  if (typeof spec === "number" && Number.isFinite(spec) && spec >= 1) {
    return Math.floor(spec);
  }
  throw new Error(`invalid quorum spec: ${String(spec)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ProposeInput {
  question: string;
  voters: Array<{ profileId: string }>;  // T6 will resolve to full Voter[]
  rounds?: number;                       // default 2
  quorum?: number | "majority" | "all";  // default "majority"
  mode?: Mode;                           // default "synthesis"
  riskTag?: RiskTag;
  context?: { artifactRefs: string[] };
  promptSnapshot: string;                // raw — stored via T2
}

export function propose(input: ProposeInput): Deliberation {
  if (!input || typeof input !== "object") {
    throw new Error("propose: input is required");
  }
  if (typeof input.question !== "string" || input.question.trim() === "") {
    throw new Error("propose: question is required");
  }
  if (typeof input.promptSnapshot !== "string") {
    throw new Error("propose: promptSnapshot is required");
  }

  const id = crypto.randomUUID();
  const ts = nowIso();
  const voterSpecs = Array.isArray(input.voters) ? input.voters : [];

  const stored = artifactStore.storeContentAddressed(input.promptSnapshot);
  const promptSnapshotHash = stored.hash;

  const rc = getRuntimeConfig();

  const rounds = typeof input.rounds === "number" && input.rounds >= 1
    ? Math.floor(input.rounds)
    : Math.max(1, Math.floor(rc.defaultRounds));

  // Quorum is resolved using the voter-spec count as a placeholder. T6
  // re-resolves it once voters are spawned and assigned real agent ids.
  // When the caller omits a spec, fall back to runtime-config defaultQuorum.
  // The runtime-config form is a string ("majority" | "all" | integer-as-string);
  // coerce numeric strings to numbers for resolveQuorum.
  let quorumSpec: number | "majority" | "all" | undefined = input.quorum;
  if (quorumSpec === undefined) {
    const dq = rc.defaultQuorum;
    if (dq === "majority" || dq === "all") {
      quorumSpec = dq;
    } else {
      const n = Number(dq);
      quorumSpec = Number.isFinite(n) && n >= 1 ? n : "majority";
    }
  }
  const quorum = resolveQuorum(quorumSpec, voterSpecs.length);

  const modeIn = input.mode ?? rc.defaultMode;
  const mode: Mode = modeIn === "tally" ? "tally" : "synthesis";

  const d: Deliberation = {
    id,
    state: "PROPOSED",
    question: input.question,
    voters: [],
    rounds,
    quorum,
    mode,
    promptSnapshotHash,
    currentRound: 0,
    votes: [],
    dissent: [],
    createdAt: ts,
    updatedAt: ts,
    // T5a — persist() bumps to 0 on first save.
    version: -1,
  };
  if (input.riskTag) d.riskTag = input.riskTag;
  if (input.context && Array.isArray(input.context.artifactRefs)) {
    d.context = { artifactRefs: [...input.context.artifactRefs] };
  }

  const ttlDays = Math.max(1, Math.floor(rc.checkpointTTLDays));
  const expiresAt = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  persist(d, expiresAt);

  try {
    _bus().emit(_EVENTS().DELIBERATION_PROPOSED, {
      deliberationId: d.id,
      question: d.question,
      // voters[] in the proposed payload reflects the *spec* — T6 fills agentIds.
      voters: voterSpecs.map((v) => ({ profileId: v.profileId, agentId: "" })),
      rounds: d.rounds,
      quorum: d.quorum,
      riskTag: d.riskTag,
      promptSnapshotHash: d.promptSnapshotHash,
      ts,
    });
  } catch {}

  return d;
}

export function transition(
  deliberationId: string,
  to: DeliberationState,
  patch?: Partial<Deliberation>,
  opts?: { expectedVersion?: number },
): Deliberation {
  const d = mustLoad(deliberationId);
  assertVersion(d, opts?.expectedVersion);
  const allowed = TRANSITIONS[d.state] || [];
  if (!allowed.includes(to)) {
    throw new Error(`illegal transition ${d.state} → ${to}`);
  }

  // Apply patch (additive) before stamping new state.
  if (patch) {
    // T5b — reject unknown keys instead of silently dropping them.
    for (const k of Object.keys(patch)) {
      if (!PATCHABLE_FIELDS.has(k as keyof Deliberation)) {
        throw new Error(`transition: field "${k}" is not patchable`);
      }
    }
    if (patch.voters !== undefined) d.voters = patch.voters;
    if (patch.currentRound !== undefined) d.currentRound = patch.currentRound;
    if (patch.synthesisHash !== undefined) d.synthesisHash = patch.synthesisHash;
    if (patch.verdict !== undefined) d.verdict = patch.verdict;
    if (patch.escalationReason !== undefined) d.escalationReason = patch.escalationReason;
    if (patch.context !== undefined) d.context = patch.context;
    if (patch.riskTag !== undefined) d.riskTag = patch.riskTag;
    if (patch.quorum !== undefined) d.quorum = patch.quorum;
    if (patch.rounds !== undefined) d.rounds = patch.rounds;
    if (patch.mode !== undefined) d.mode = patch.mode;
    if (patch.settledAt !== undefined) d.settledAt = patch.settledAt;
    // T6-FU-3 — caller passes the *new* full array (existing + new entry).
    if (patch.degradation !== undefined) d.degradation = patch.degradation;
    if (patch.verdictSource !== undefined) d.verdictSource = patch.verdictSource;
  }

  const fromState = d.state;
  d.state = to;

  if (to === "SETTLED" || to === "ESCALATED" || to === "EXHAUSTED") {
    d.settledAt = nowIso();
  }

  persist(d);

  // Emit destination-specific events.
  try {
    const E = _EVENTS();
    const bus = _bus();
    if (to === "SYNTHESIZING" && d.synthesisHash) {
      // T5d — emit real tally for the current round; T7 may use this as
      // metadata when assembling the SynthesisReport.
      bus.emit(E.DELIBERATION_SYNTHESIS, {
        deliberationId: d.id,
        synthesisHash: d.synthesisHash,
        tally: computeTallyForRound(d, d.currentRound),
        dissentVoterIds: d.dissent.map((x) => x.voterId),
        ts: d.updatedAt,
      });
    } else if (to === "SETTLED" && d.verdict && d.verdict !== "escalated") {
      const tally = computeTallyForRound(d, d.currentRound);
      bus.emit(E.DELIBERATION_CONVERGED, {
        deliberationId: d.id,
        round: d.currentRound,
        verdict: d.verdict,
        finalTally: tally,
        ts: d.updatedAt,
      });
    } else if (to === "ESCALATED") {
      const tally = computeTallyForRound(d, d.currentRound);
      bus.emit(E.DELIBERATION_ESCALATED, {
        deliberationId: d.id,
        reason: d.escalationReason || "explicit",
        lastTally: tally,
        ts: d.updatedAt,
      });
    }
    // Suppress unused-var lint by referencing fromState.
    void fromState;
  } catch {}

  return d;
}

function computeTallyForRound(d: Deliberation, round: number): { approve: number; changes: number } {
  const tally = { approve: 0, changes: 0 };
  for (const v of d.votes) {
    if (v.round !== round) continue;
    if (v.bit === "APPROVE") tally.approve++;
    else if (v.bit === "CHANGES") tally.changes++;
  }
  return tally;
}

export function recordVote(
  deliberationId: string,
  vote: Vote,
  opts?: { expectedVersion?: number },
): Deliberation {
  const d = mustLoad(deliberationId);
  assertVersion(d, opts?.expectedVersion);
  if (!vote || typeof vote !== "object") {
    throw new Error("recordVote: vote is required");
  }
  if (vote.bit !== "APPROVE" && vote.bit !== "CHANGES") {
    throw new Error(`recordVote: invalid bit ${String(vote.bit)}`);
  }
  // T5c — votes must only land in REVIEWING / CONVERGING. Anything else is
  // a bug or a stale caller; better to fail loudly than corrupt the audit log.
  if (d.state !== "REVIEWING" && d.state !== "CONVERGING") {
    throw new Error(`recordVote: cannot record vote in state ${d.state}`);
  }
  d.votes.push({ ...vote });
  persist(d);

  try {
    _bus().emit(_EVENTS().DELIBERATION_VOTE, {
      deliberationId: d.id,
      round: vote.round,
      voterId: vote.voterId,
      profileId: vote.profileId,
      modelId: vote.modelId,
      bit: vote.bit,
      rationaleHash: vote.rationaleHash,
      promptSnapshotHash: vote.promptSnapshotHash,
      ts: vote.ts,
    });
  } catch {}

  return d;
}

export function recordDissent(
  deliberationId: string,
  dissent: Dissent,
  opts?: { expectedVersion?: number },
): Deliberation {
  const d = mustLoad(deliberationId);
  assertVersion(d, opts?.expectedVersion);
  if (!dissent || typeof dissent !== "object") {
    throw new Error("recordDissent: dissent is required");
  }
  // T5c — dissent is allowed during REVIEWING / SYNTHESIZING / CONVERGING
  // (the synthesizer may add dissent verbatim) and during ESCALATED (a human
  // overriding may attach dissent context). It is NOT allowed in PROPOSED
  // (no review yet), EXHAUSTED (cancelled, no minority report), or SETTLED
  // unless an override is being recorded — and override has its own setter,
  // so SETTLED-without-override-in-flight is rejected here.
  const s = d.state;
  const isSettledClean = s === "SETTLED" && d.override === undefined;
  if (s === "PROPOSED" || s === "EXHAUSTED" || isSettledClean) {
    throw new Error(`recordDissent: cannot record dissent in state ${s}`);
  }
  // T7-FU-a: persistence boundary stamps the canonical `ts`. synthesize()
  // returns Dissent objects with ts="" (or omitted) so the in-memory report
  // is deterministic for replay/dedup; recordDissent owns the wallclock.
  const stamped: Dissent = { ...dissent };
  if (typeof stamped.ts !== "string" || stamped.ts === "") {
    stamped.ts = nowIso();
  }
  d.dissent.push(stamped);
  persist(d);
  return d;
}

export function recordOverride(
  deliberationId: string,
  override: Override,
  opts?: { expectedVersion?: number },
): Deliberation {
  const d = mustLoad(deliberationId);
  assertVersion(d, opts?.expectedVersion);
  if (!override || typeof override !== "object") {
    throw new Error("recordOverride: override is required");
  }
  // T5e — capture pre-override state so audit consumers can tell whether the
  // override displaced an existing verdict (SETTLED → SETTLED with override
  // block) or resolved an escalation (ESCALATED → SETTLED).
  const wasSettled = d.state === "SETTLED";
  const originalSettledAt = wasSettled ? d.settledAt : undefined;

  d.override = { ...override };
  // Provenance: humanId carrying a "judge:" prefix marks the override as
  // having come from the auto-judge path; everything else is treated as a
  // human override. The council path sets verdictSource="council" directly
  // via the SETTLE patch in round-controller.ts.
  d.verdictSource =
    typeof override.humanId === "string" && override.humanId.startsWith("judge:")
      ? "judge"
      : "human";
  if (d.state !== "SETTLED") {
    // Override always lands the deliberation on SETTLED — record explicitly so
    // legality table is honored (ESCALATED → SETTLED is allowed).
    if ((TRANSITIONS[d.state] || []).includes("SETTLED")) {
      d.state = "SETTLED";
      d.settledAt = nowIso();
    }
    // If we were already SETTLED, leave state alone — override block is added.
  }
  persist(d);

  try {
    const payload: any = {
      deliberationId: d.id,
      humanId: override.humanId,
      decision: override.decision,
      reason: "",
      reasonHash: override.reasonHash,
      ts: override.ts,
      wasSettled,
    };
    if (originalSettledAt !== undefined) payload.originalSettledAt = originalSettledAt;
    _bus().emit(_EVENTS().DELIBERATION_OVERRIDE, payload);
  } catch {}

  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// recordHumanNudge — Slice C
//
// Append a single nudge entry to the audit array and clear the awaitingNudge
// marker so the orchestration loop can resume. State is NOT changed — nudges
// happen inside CONVERGING and the post-resume transition is the caller's
// responsibility.
//
// `textHash` is null for the "skip" path (CAS write skipped, audit still
// captures the choice).
// ─────────────────────────────────────────────────────────────────────────────
export function recordHumanNudge(
  deliberationId: string,
  nudge: { afterRound: number; textHash: string | null; contributedBy: "user" | "skip" },
  opts?: { expectedVersion?: number },
): Deliberation {
  const d = mustLoad(deliberationId);
  assertVersion(d, opts?.expectedVersion);
  if (!nudge || typeof nudge !== "object") {
    throw new Error("recordHumanNudge: nudge is required");
  }
  if (typeof nudge.afterRound !== "number" || nudge.afterRound < 1) {
    throw new Error(`recordHumanNudge: afterRound must be >= 1`);
  }
  if (nudge.contributedBy !== "user" && nudge.contributedBy !== "skip") {
    throw new Error(`recordHumanNudge: contributedBy must be "user" | "skip"`);
  }
  if (d.state !== "CONVERGING" && d.state !== "REVIEWING" && d.state !== "SYNTHESIZING") {
    throw new Error(`recordHumanNudge: cannot record nudge in state ${d.state}`);
  }
  const entry = {
    afterRound: nudge.afterRound,
    textHash: nudge.textHash,
    contributedBy: nudge.contributedBy,
    ts: nowIso(),
  };
  d.humanNudges = [...(Array.isArray(d.humanNudges) ? d.humanNudges : []), entry];
  // Resume gate — clear the await marker.
  if (d.awaitingNudge) {
    d.awaitingNudge = undefined;
  }
  persist(d);

  try {
    _bus().emit(_EVENTS().DELIBERATION_HUMAN_NUDGE, {
      deliberationId: d.id,
      afterRound: entry.afterRound,
      contributedBy: entry.contributedBy,
      textHash: entry.textHash,
      ts: entry.ts,
    });
  } catch {}
  return d;
}

export function loadDeliberation(deliberationId: string): Deliberation | null {
  return readFromCheckpoint(deliberationId);
}

export function listDeliberations(filter?: { state?: DeliberationState; includeExpired?: boolean }): Deliberation[] {
  const records = checkpointStore.list({
    kind: CHECKPOINT_KIND,
    includeExpired: filter?.includeExpired === true,
  });
  const out: Deliberation[] = [];
  for (const r of records) {
    const d = (r as any).deliberation as Deliberation | undefined;
    if (!d) continue;
    if (filter?.state && d.state !== filter.state) continue;
    out.push(d);
  }
  return out;
}
