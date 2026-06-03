// Deliberation public surface — T5
export * from "./types";
export {
  setRuntimeConfig,
  getRuntimeConfig,
  resetRuntimeConfig,
} from "./runtime-config";
export type { DeliberationRuntimeConfig } from "./runtime-config";
export {
  TRANSITIONS,
  propose,
  transition,
  recordVote,
  recordDissent,
  recordOverride,
  recordHumanNudge,
  loadDeliberation,
  listDeliberations,
  StaleDeliberationError,
} from "./run";
export {
  decide,
  applyDecision,
} from "./round-controller";
export type {
  RoundDecisionInput,
  RoundDecision,
  RoundApplyResult,
  ApplyDecisionOptions,
} from "./round-controller";
export {
  synthesize,
  canonicalize,
} from "./synthesize";
export type {
  VoterReview,
  SynthesisInput,
  SynthesizeOptions,
  SynthesisOutput,
  Severity,
} from "./synthesize";
export {
  assembleCouncil,
  reassembleCouncil,
  resolveQuorum,
  applyDegradation,
  applyGeneralistSeatInvariant,
} from "./quorum";
export type {
  VoterCandidate,
  AssembleInput,
  AssembleOutcome,
  AssembleEscalationReason,
  AssembleDeps,
  DroppedVoter,
  DegradationContext,
  DegradationDecision,
  ProbeFailure,
  ProbeFailureKind,
  ReassembleInput,
  ReassembleOutcome,
  GeneralistSeatConfig,
  GeneralistSeatResult,
} from "./quorum";
export {
  listRolePacks,
  getRolePack,
  resolveVoters,
  normalizeVotersInput,
} from "./role-packs";
export type {
  RolePackId,
  RolePackSpec,
  VotersInput,
} from "./role-packs";
