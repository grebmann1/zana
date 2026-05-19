// Deliberation types — T5
//
// Shared, audit-grade types for the multi-voice consensus primitive.
// See ~/.zana/artifacts/f4de8302-...json (design doc) for context.
//
// All hashes are canonical "sha256:<64-hex>" — produced by the content-
// addressed artifact store (T2). All timestamps are ISO 8601 strings.
// `bit` is uppercase to match the wire payload contract from T1.

export type DeliberationState =
  | "PROPOSED"
  | "REVIEWING"
  | "SYNTHESIZING"
  | "CONVERGING"
  | "SETTLED"
  | "ESCALATED"
  | "EXHAUSTED";

export type Verdict =
  | "approve"
  | "approve_with_conditions"
  | "reject"
  | "escalated";

export type VoteBit = "APPROVE" | "CHANGES";

export type RiskTag = "low" | "medium" | "high";

export type Mode = "synthesis" | "tally";

export type EscalationReason =
  | "cap_exhausted"
  | "quorum_lost"
  | "dropout_was_dissenter"
  | "risk_high"
  | "explicit";

export interface Voter {
  agentId: string;       // assigned at REVIEWING phase via spawnHeadlessAgent (T6)
  profileId: string;
  modelId: string;
}

export interface Vote {
  voterId: string;          // = Voter.agentId
  profileId: string;
  modelId: string;
  round: number;            // 1-indexed
  bit: VoteBit;
  rationaleHash: string;    // sha256:... — content-addressed via T2
  promptSnapshotHash: string;
  ts: string;
}

export interface Dissent {
  voterId: string;
  profileId: string;
  round: number;
  rationaleHash: string;    // verbatim, never collapsed
  ts: string;
}

export interface SynthesisFinding {
  severity: "CRITICAL" | "MAJOR" | "MINOR" | "NIT";
  text: string;
  sourceVoterIds: string[];          // who flagged it
  category: "consensus" | "unique" | "disagreement";
}

export interface SynthesisReport {
  // T7 will fill this in fully; T5 just defines the contract.
  findings: SynthesisFinding[];
  tally: { approve: number; changes: number };
  dissentVoterIds: string[];
  ts: string;
}

export interface Override {
  humanId: string;
  decision: "approve" | "reject" | "rework";
  reasonHash: string;
  ts: string;
}

export interface Deliberation {
  id: string;                       // uuid
  state: DeliberationState;
  question: string;
  voters: Voter[];                  // populated when REVIEWING begins
  rounds: number;                   // hard cap
  quorum: number;                   // resolved integer
  mode: Mode;
  riskTag?: RiskTag;
  promptSnapshotHash: string;       // sha256, content-addressed
  context?: { artifactRefs: string[] };

  // Per-round state
  currentRound: number;             // 0 before review, 1+ during converging
  votes: Vote[];                    // append-only, all rounds
  synthesisHash?: string;           // sha256 of SynthesisReport once T7 runs

  // Outcome
  verdict?: Verdict;
  dissent: Dissent[];               // verbatim minority report
  escalationReason?: EscalationReason;
  override?: Override;

  // Lifecycle
  createdAt: string;
  updatedAt: string;
  settledAt?: string;

  // Optimistic concurrency — bumped on every persist (T5a).
  // Callers that load-then-mutate can pass `expectedVersion` to mutation
  // helpers; mismatch throws StaleDeliberationError so the caller can reload
  // and retry. New deliberations start at version: 0.
  version: number;

  // T6-FU-3 — append-only audit trail of voters dropped during (re)assembly.
  // One entry per assembleCouncil/reassembleCouncil call that resulted in a
  // READY transition AND dropped at least one voter. The event log
  // (deliberation:degraded) carries the same payload, but persisting here
  // means audit consumers can answer "why is voter X missing from this
  // round?" by reading the deliberation alone.
  degradation?: DegradationEntry[];
}

export interface DroppedVoterAudit {
  profileId: string;
  // Mirrors ProbeFailureKind from @zana/core's deliberation-events.ts.
  // Kept as a string union here to avoid a hard import edge.
  reason:
    | "timeout"
    | "validation"
    | "misconfig"
    | "auth"
    | "rate_limit"
    | "quota"
    | "transport"
    | "spawn";
  detail?: string;
}

export interface DegradationEntry {
  round: number;                 // round at the time of (re)assembly
  dropped: DroppedVoterAudit[];
  ts: string;                    // ISO
}
