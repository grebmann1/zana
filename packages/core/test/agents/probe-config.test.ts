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
    expect(cfg.probeTimeoutMs).toBe(90000);
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
    expect(cfg.probeTimeoutMs).toBe(90000);
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
});
