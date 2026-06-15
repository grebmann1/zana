import { describe, it, expect, beforeEach } from "vitest";
import {
  setProbeConfig,
  getProbeConfig,
  resetProbeConfig,
} from "@zana-ai/core/src/agents/probe-config.ts";

describe("probe-config", () => {
  beforeEach(() => {
    resetProbeConfig();
  });

  it("getProbeConfig returns the built-in defaults after reset", () => {
    const cfg = getProbeConfig();
    expect(cfg.probeTimeoutMs).toBe(120000);
    expect(cfg.probeRawMaxBytes).toBe(1024);
    expect(cfg.probeCacheTtlMs).toBe(300000);
    expect(cfg.transientProbeCacheTtlMs).toBe(30000);
  });

  it("setProbeConfig merges over active config (partial update)", () => {
    setProbeConfig({ probeTimeoutMs: 5000 });
    const cfg = getProbeConfig();
    expect(cfg.probeTimeoutMs).toBe(5000);
    // Unchanged fields preserve their default values.
    expect(cfg.probeRawMaxBytes).toBe(1024);
    expect(cfg.probeCacheTtlMs).toBe(300000);
  });

  it("setProbeConfig merges over the already-mutated active value, not over defaults", () => {
    setProbeConfig({ probeTimeoutMs: 5000 });
    setProbeConfig({ probeRawMaxBytes: 512 });
    const cfg = getProbeConfig();
    // Both mutations should survive — second call must NOT reset first.
    expect(cfg.probeTimeoutMs).toBe(5000);
    expect(cfg.probeRawMaxBytes).toBe(512);
  });

  it("resetProbeConfig restores defaults even after multiple setProbeConfig calls", () => {
    setProbeConfig({ probeTimeoutMs: 1, probeRawMaxBytes: 1, probeCacheTtlMs: 1 });
    resetProbeConfig();
    const cfg = getProbeConfig();
    expect(cfg.probeTimeoutMs).toBe(120000);
    expect(cfg.probeRawMaxBytes).toBe(1024);
    expect(cfg.probeCacheTtlMs).toBe(300000);
  });

  it("setProbeConfig with null/undefined partial does not throw and preserves current config", () => {
    setProbeConfig({ probeTimeoutMs: 9999 });
    expect(() => setProbeConfig(null as any)).not.toThrow();
    expect(getProbeConfig().probeTimeoutMs).toBe(9999);
  });

  it("probeCacheTtlMs of 0 is accepted (disables cache)", () => {
    setProbeConfig({ probeCacheTtlMs: 0 });
    expect(getProbeConfig().probeCacheTtlMs).toBe(0);
  });

  // setProbeConfig reassigns `active` to a NEW object ({...active, ...partial})
  // rather than mutating in place, so a config snapshot captured via an earlier
  // getProbeConfig() call is copy-on-write stable: a caller that grabbed the
  // config before an update must NOT see the field change under it. Pins the
  // snapshot-isolation contract the existing suite leaves untested.
  it("does not retroactively mutate a config reference captured before setProbeConfig", () => {
    const before = getProbeConfig();
    expect(before.probeTimeoutMs).toBe(120000);

    setProbeConfig({ probeTimeoutMs: 5000 });

    // The earlier snapshot still reflects the pre-update value...
    expect(before.probeTimeoutMs).toBe(120000);
    // ...while a fresh read sees the new value, and the two are distinct objects.
    const after = getProbeConfig();
    expect(after.probeTimeoutMs).toBe(5000);
    expect(after).not.toBe(before);
  });

  // transientProbeCacheTtlMs of 0 means "skip cache for transient failures"
  // (the original FU-T2 behavior, per probe-config.ts). Mirrors the
  // probeCacheTtlMs "0 disables" guard above for the cost-sensitive transient
  // path, and pins that the partial merge leaves the other TTLs untouched.
  it("transientProbeCacheTtlMs of 0 is accepted (disables transient cache) and preserves other fields", () => {
    setProbeConfig({ transientProbeCacheTtlMs: 0 });
    const cfg = getProbeConfig();
    expect(cfg.transientProbeCacheTtlMs).toBe(0);
    // Sibling TTLs must remain at their defaults — 0 must not bleed across fields.
    expect(cfg.probeCacheTtlMs).toBe(300000);
    expect(cfg.probeTimeoutMs).toBe(120000);
  });
});
