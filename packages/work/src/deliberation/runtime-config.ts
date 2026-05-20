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
  // itself lives in @zana/core/probe-cache.ts; this field is mirrored here
  // because the deliberation module publishes one config snapshot to BOTH
  // bridges. 0 disables caching; default 5 min.
  probeCacheTtlMs: number;
  synthesisSimilarityThreshold: number;
}

const DEFAULTS: DeliberationRuntimeConfig = {
  defaultRounds: 2,
  defaultQuorum: "majority",
  defaultMode: "synthesis",
  checkpointTTLDays: 7,
  occMaxRetries: 3,
  probeTimeoutMs: 30000,
  probeRawMaxBytes: 1024,
  probeCacheTtlMs: 300000,
  synthesisSimilarityThreshold: 0.45,
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
