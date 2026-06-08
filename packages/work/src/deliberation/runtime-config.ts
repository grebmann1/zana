// Runtime config — populated by the deliberation core module at init time.
// All defaults match the configSchema defaults in core/modules/deliberation/module.json.
// Hard-coded fallbacks here ensure deliberation works even if the module didn't init
// (e.g. tests that don't bootstrap modules).

export interface DeliberationRuntimeConfig {
  defaultRounds: number;
  defaultQuorum: string;            // "majority" | "all" | integer-as-string
  defaultMode: "synthesis" | "tally";
  checkpointTTLDays: number;
  occMaxRetries: number;
  probeTimeoutMs: number;
  probeRawMaxBytes: number;
  // T6-FU-2 — TTL on the (profileId+modelId) probe-result cache. The cache
  // itself lives in @zana-ai/core/probe-cache.ts; this field is mirrored here
  // because the deliberation module publishes one config snapshot to BOTH
  // bridges. 0 disables caching; default 5 min.
  probeCacheTtlMs: number;
  synthesisSimilarityThreshold: number;
  // Per-voter timeout for collectReviews. Real-Claude voters reading actual
  // codebases need more than the original 10-min default; bumped to 20 min
  // after the May 2026 real-Claude smoke test caught all 3 voters timing out.
  voterTimeoutMs: number;
  // Auto-judge for ESCALATED deliberations.
  //   "human"  — leave ESCALATED, wait for zana_deliberation_override.
  //   "judge"  — spawn a single judge agent that reads the transcript and
  //              emits a verdict; lands on SETTLED via recordOverride.
  //   "hybrid" — equivalent to "judge" today (riskTag=high is always
  //              human-only regardless of strategy, so the difference between
  //              "judge" and "hybrid" is only in operator intent).
  escalationStrategy: "human" | "judge" | "hybrid";
  judgeProfileId: string;
  judgeTimeoutMs: number;
  // Slice B — generalist-seat invariant.
  //
  // When a council has ≥ generalistSeatThreshold voters and none of them is
  // flagged generalist, append `generalistProfileId` so cross-cutting concerns
  // can't fall between specialist domains. Default ON, threshold=3, profile
  // researcher. Off-switch via `generalistSeat: { enabled: false, ... }`.
  generalistSeat: { enabled: boolean; profileId: string };
  generalistSeatThreshold: number;
}

const DEFAULTS: DeliberationRuntimeConfig = {
  defaultRounds: 2,
  defaultQuorum: "majority",
  defaultMode: "synthesis",
  checkpointTTLDays: 7,
  occMaxRetries: 3,
  // 90s gives cold-start Claude calls enough time to return on slow days.
  // 30s was too tight: a single slow leg dropped a voter and the council
  // escalated with "probe quorum lost" repeatedly. Per-leg, not total.
  // Mirror packages/core/src/agents/probe-config.ts default. The
  // deliberation module publishes this snapshot to BOTH bridges at boot
  // (see modules/deliberation/index.js), so this default must match —
  // otherwise the module clobbers the core probe-config bump back to 30s.
  probeTimeoutMs: 90000,
  probeRawMaxBytes: 1024,
  probeCacheTtlMs: 300000,
  synthesisSimilarityThreshold: 0.45,
  voterTimeoutMs: 20 * 60 * 1000,
  escalationStrategy: "human",
  judgeProfileId: "judge",
  judgeTimeoutMs: 10 * 60 * 1000,
  generalistSeat: { enabled: true, profileId: "researcher" },
  generalistSeatThreshold: 3,
};

let active: DeliberationRuntimeConfig = { ...DEFAULTS };

// Merge over current `active` (NOT over DEFAULTS). Two consecutive partial calls accumulate.
// The deliberation core module always publishes a full ctx.config snapshot so behavior is
// identical for that path; the merge semantic only matters for direct callers (tests, future
// programmatic config edits). Use `resetRuntimeConfig()` first if you need a clean slate.
export function setRuntimeConfig(partial: Partial<DeliberationRuntimeConfig>): void {
  active = { ...active, ...(partial || {}) };
}

export function getRuntimeConfig(): Readonly<DeliberationRuntimeConfig> {
  return active;
}

// For tests — restore pristine defaults between cases.
export function resetRuntimeConfig(): void {
  active = { ...DEFAULTS };
}
