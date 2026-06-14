import { describe, it, expect, beforeEach } from "vitest";
import * as rc from "@zana-ai/work/src/deliberation/runtime-config.ts";
import * as probeCfg from "@zana-ai/core/src/agents/probe-config.ts";

// Pins the cross-package invariant documented in runtime-config.ts:
//
//   "Mirror packages/core/src/agents/probe-config.ts default. The
//    deliberation module publishes this snapshot to BOTH bridges at boot,
//    so this default MUST match — otherwise the module clobbers the core
//    probe-config value."
//
// The individual default values are each pinned in their own package's
// suite, but nothing asserts the two stay EQUAL. If someone bumps one
// default without the other, deliberation boot silently overwrites core's
// probe timeout/byte-cap with a stale value. These tests fail loudly on
// that drift instead.
describe("runtime-config ↔ core probe-config default parity", () => {
  beforeEach(() => {
    rc.resetRuntimeConfig();
    probeCfg.resetProbeConfig();
  });

  it("work's probeTimeoutMs default equals core's probe-config default", () => {
    expect(rc.getRuntimeConfig().probeTimeoutMs).toBe(
      probeCfg.getProbeConfig().probeTimeoutMs,
    );
  });

  it("work's probeRawMaxBytes default equals core's probe-config default", () => {
    expect(rc.getRuntimeConfig().probeRawMaxBytes).toBe(
      probeCfg.getProbeConfig().probeRawMaxBytes,
    );
  });

  it("parity holds against the pristine core defaults, not a mutated snapshot", () => {
    // Mutating core's active config must not be what we're comparing against:
    // reset first, then read, so a leaked override elsewhere can't mask drift.
    probeCfg.setProbeConfig({ probeTimeoutMs: 999 });
    probeCfg.resetProbeConfig();
    const core = probeCfg.getProbeConfig();
    const work = rc.getRuntimeConfig();
    expect(work.probeTimeoutMs).toBe(core.probeTimeoutMs);
    expect(work.probeRawMaxBytes).toBe(core.probeRawMaxBytes);
  });
});
