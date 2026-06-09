// Probe runtime config — lives in @zana-ai/core (parallel to the deliberation
// runtime-config in @zana-ai/work) so probeAgent does NOT have to require @zana-ai/work
// (which would close the dependency cycle). The deliberation core module writes
// to BOTH bridges at init time.

export interface ProbeRuntimeConfig {
  probeTimeoutMs: number;
  probeRawMaxBytes: number;
  // T6-FU-2 — TTL on the (profileId+modelId) probe-result cache. 0 disables.
  // Default 5 min: probe outcomes (auth, model availability, instruction-
  // following capability) change slowly compared to a deliberation's lifetime.
  probeCacheTtlMs: number;
  // Short TTL for transient probe failures (timeout/transport/quota/rate_limit).
  // Without this, a flaky run re-pays the full 9-spawn probe cost on every
  // retry. With it, a single slow probe is remembered just long enough that
  // the next deliberation in the same minute doesn't re-trigger the same
  // failure mode. 0 disables (caller falls back to "skip cache for transient"
  // — the original FU-T2 behavior). Default 30s: long enough to dampen a
  // burst, short enough that real recovery surfaces quickly.
  transientProbeCacheTtlMs: number;
}

const DEFAULTS: ProbeRuntimeConfig = {
  // 120s per-leg ceiling. NOT a latency cost — a healthy voter clears all
  // three probe legs in ~10-20s (measured: full 3-voter probe phase took
  // ~20s wall-clock in the 2026-06-09 real-Claude run). The budget only
  // pays out when a probe is genuinely stuck; it exists to distinguish
  // "slow cold-start / rate-limit backoff" from "dead voter". 30s was too
  // tight (false drops → "probe quorum lost"); 90s fixed that; 120s adds
  // headroom for a rate-limit backoff or two. Going higher trades
  // dead-voter-detection speed for slowness-tolerance we don't need —
  // a truly wedged voter is caught by drop+escalate, not a bigger timeout.
  probeTimeoutMs: 120000,
  probeRawMaxBytes: 1024,
  probeCacheTtlMs: 300000,
  transientProbeCacheTtlMs: 30000,
};

let active: ProbeRuntimeConfig = { ...DEFAULTS };

// Merge over current `active` (NOT over DEFAULTS). Same semantic as setRuntimeConfig
// in @zana-ai/work. Use `resetProbeConfig()` for a clean slate.
export function setProbeConfig(partial: Partial<ProbeRuntimeConfig>): void {
  active = { ...active, ...(partial || {}) };
}

export function getProbeConfig(): Readonly<ProbeRuntimeConfig> {
  return active;
}

export function resetProbeConfig(): void {
  active = { ...DEFAULTS };
}
