// Probe runtime config — lives in @zana/core (parallel to the deliberation
// runtime-config in @zana/work) so probeAgent does NOT have to require @zana/work
// (which would close the dependency cycle). The deliberation core module writes
// to BOTH bridges at init time.

export interface ProbeRuntimeConfig {
  probeTimeoutMs: number;
  probeRawMaxBytes: number;
}

const DEFAULTS: ProbeRuntimeConfig = {
  probeTimeoutMs: 30000,
  probeRawMaxBytes: 1024,
};

let active: ProbeRuntimeConfig = { ...DEFAULTS };

// Merge over current `active` (NOT over DEFAULTS). Same semantic as setRuntimeConfig
// in @zana/work. Use `resetProbeConfig()` for a clean slate.
export function setProbeConfig(partial: Partial<ProbeRuntimeConfig>): void {
  active = { ...active, ...(partial || {}) };
}

export function getProbeConfig(): Readonly<ProbeRuntimeConfig> {
  return active;
}

export function resetProbeConfig(): void {
  active = { ...DEFAULTS };
}
