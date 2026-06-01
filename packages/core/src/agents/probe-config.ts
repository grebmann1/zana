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
}

const DEFAULTS: ProbeRuntimeConfig = {
  probeTimeoutMs: 30000,
  probeRawMaxBytes: 1024,
  probeCacheTtlMs: 300000,
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
