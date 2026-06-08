import { describe, it, expect, beforeEach } from "vitest";
import * as rc from "@zana-ai/work/src/deliberation/runtime-config.ts";

describe("deliberation runtime-config", () => {
  beforeEach(() => {
    rc.resetRuntimeConfig();
  });

  it("returns built-in defaults after reset", () => {
    const cfg = rc.getRuntimeConfig();
    expect(cfg.defaultRounds).toBe(2);
    expect(cfg.defaultQuorum).toBe("majority");
    expect(cfg.defaultMode).toBe("synthesis");
    expect(cfg.checkpointTTLDays).toBe(7);
    expect(cfg.occMaxRetries).toBe(3);
    expect(cfg.probeTimeoutMs).toBe(90000);
    expect(cfg.probeRawMaxBytes).toBe(1024);
    expect(cfg.probeCacheTtlMs).toBe(300000);
    expect(cfg.synthesisSimilarityThreshold).toBe(0.45);
    expect(cfg.voterTimeoutMs).toBe(20 * 60 * 1000);
    expect(cfg.escalationStrategy).toBe("human");
    expect(cfg.judgeProfileId).toBe("judge");
    expect(cfg.judgeTimeoutMs).toBe(10 * 60 * 1000);
  });

  it("partial setRuntimeConfig overrides only the supplied fields", () => {
    rc.setRuntimeConfig({ defaultRounds: 5, defaultQuorum: "all" });
    const cfg = rc.getRuntimeConfig();
    expect(cfg.defaultRounds).toBe(5);
    expect(cfg.defaultQuorum).toBe("all");
    // unrelated fields stay at defaults
    expect(cfg.defaultMode).toBe("synthesis");
    expect(cfg.occMaxRetries).toBe(3);
  });

  it("two consecutive partial calls accumulate (do not reset between them)", () => {
    rc.setRuntimeConfig({ defaultRounds: 4 });
    rc.setRuntimeConfig({ escalationStrategy: "judge" });
    const cfg = rc.getRuntimeConfig();
    expect(cfg.defaultRounds).toBe(4);          // from first call
    expect(cfg.escalationStrategy).toBe("judge"); // from second call
    expect(cfg.defaultMode).toBe("synthesis");   // never touched
  });

  it("resetRuntimeConfig restores defaults after override", () => {
    rc.setRuntimeConfig({ defaultRounds: 99, escalationStrategy: "hybrid" });
    rc.resetRuntimeConfig();
    const cfg = rc.getRuntimeConfig();
    expect(cfg.defaultRounds).toBe(2);
    expect(cfg.escalationStrategy).toBe("human");
  });

  it("getRuntimeConfig returns a readonly snapshot (re-reading reflects later updates)", () => {
    const snap1 = rc.getRuntimeConfig();
    expect(snap1.defaultRounds).toBe(2);
    rc.setRuntimeConfig({ defaultRounds: 10 });
    const snap2 = rc.getRuntimeConfig();
    expect(snap2.defaultRounds).toBe(10);
    // Original snapshot still reads 2 (it was captured before the update)
    expect(snap1.defaultRounds).toBe(2);
  });

  it("setRuntimeConfig with empty object leaves all values unchanged", () => {
    rc.setRuntimeConfig({});
    expect(rc.getRuntimeConfig().defaultRounds).toBe(2);
    expect(rc.getRuntimeConfig().defaultQuorum).toBe("majority");
  });

  it("setRuntimeConfig with null/undefined-ish partial does not throw", () => {
    // The implementation guards `partial || {}`, so null-ish is tolerated
    expect(() => rc.setRuntimeConfig(null as any)).not.toThrow();
    expect(rc.getRuntimeConfig().defaultRounds).toBe(2);
  });
});
