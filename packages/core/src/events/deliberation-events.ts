// Typed payload contracts for deliberation:* events emitted on the bus.
// These events are an audit substrate — keep schemas strict and additive.
// See packages/core/src/events/bus.ts for the matching EVENTS constants.
//
// Probe-adjacent shapes (ProbeFailure, AgentProbedPayload) live here rather
// than in a sibling probe-events.ts because probes are a deliberation/quorum
// prerequisite — T6 anti-dropout-bias logic consumes ProbeFailure.kind, and
// keeping the audit substrate in one file keeps the contract surface small.

// FU-T3a-3 — split the legacy "spawn" bucket into typed retry-policy buckets.
// T9 retry-policy will key off these to distinguish transient (timeout,
// rate_limit, transport) from structural (auth, quota, misconfig, validation)
// failures. Order is documentation-only — kept legacy buckets at the end so
// audit consumers diffing the union see additions, not relocations.
export type ProbeFailureKind =
  | "timeout"
  | "validation"
  | "misconfig"
  | "auth"           // 401/403, missing token, gateway-rejected credentials
  | "rate_limit"     // 429, gateway-rejected too-many-requests
  | "quota"          // 402/payment-required, quota exhausted
  | "transport"      // network/DNS/TLS, child-process spawn errors that aren't auth/rate/quota
  | "spawn";         // process-level failure that doesn't match the above (legacy/unknown)

export interface ProbeFailure {
  // null indicates a whole-probe failure (e.g. profile has no declared model).
  leg: "factual" | "instructionFollowing" | "toolUse" | null;
  kind: ProbeFailureKind;
  reason: string;          // human-readable
  raw?: string;            // optional raw output for debugging (truncated to 1KB)
}

export interface AgentProbedPayload {
  probeId: string;
  profileId: string;
  modelId: string;
  ok: boolean;
  failures: ProbeFailure[];
  latencyMs: number;
  ts: string;              // ISO
  // T6-FU-2 — true when this event reports a cache lookup, false on a real
  // probe. latencyMs reflects the original probe in either case (the cache
  // never re-times the lookup itself).
  cached: boolean;
}

export interface DeliberationProposedPayload {
  deliberationId: string;
  question: string;
  voters: { profileId: string; agentId: string }[];
  rounds: number;          // hard cap
  quorum: number;          // resolved integer
  riskTag?: "low" | "medium" | "high";
  promptSnapshotHash: string;   // sha256 of the shared prompt
  ts: string;              // ISO
}

export interface DeliberationVotePayload {
  deliberationId: string;
  round: number;           // 1-indexed
  voterId: string;         // agentId
  profileId: string;
  modelId: string;         // resolved model used by the voter
  bit: "APPROVE" | "CHANGES";
  rationaleHash: string;   // sha256 of rationale stored in artifact-store (T2)
  promptSnapshotHash: string;
  ts: string;
}

export interface DeliberationSynthesisPayload {
  deliberationId: string;
  synthesisHash: string;   // sha256 of structured SynthesisReport
  tally: { approve: number; changes: number };  // metadata, not authority
  dissentVoterIds: string[];
  ts: string;
}

export interface DeliberationConvergedPayload {
  deliberationId: string;
  round: number;
  verdict: "approve" | "approve_with_conditions" | "reject";
  finalTally: { approve: number; changes: number };
  ts: string;
}

export interface DeliberationEscalatedPayload {
  deliberationId: string;
  reason:
    | "cap_exhausted"
    | "quorum_lost"
    | "dropout_was_dissenter"
    | "risk_high"
    | "explicit";
  lastTally?: { approve: number; changes: number };
  ts: string;
}

// T6-FU-3 — degradation audit. Every (re)assembly that drops voters appends
// an entry to Deliberation.degradation AND fires this event so audit consumers
// can answer "why is voter X missing from round N?" from the event log alone.
export interface DroppedVoterRecord {
  profileId: string;
  reason: ProbeFailureKind;
  detail?: string;
}

export interface DeliberationDegradedPayload {
  deliberationId: string;
  // Round at the time of (re)assembly. For initial assembleCouncil this is the
  // currentRound at PROPOSED (typically 0). For reassembleCouncil this is the
  // post-increment round (the round about to begin).
  round: number;
  dropped: DroppedVoterRecord[];
  ts: string;              // ISO
}

export interface DeliberationOverridePayload {
  deliberationId: string;
  humanId: string;
  decision: "approve" | "reject" | "rework";
  reason: string;
  reasonHash: string;      // content-addressed in artifact-store
  ts: string;
  // T5e — audit consumers should not have to join event streams to know
  // whether an override displaced an existing verdict (SETTLED → SETTLED with
  // override block) or resolved an escalation (ESCALATED → SETTLED).
  wasSettled: boolean;
  originalSettledAt?: string;  // ISO; only set when wasSettled === true
}
