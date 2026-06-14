// Regression pin for the judge-escalation fields in deliberation/runtime-config.ts.
//
// Three fields drive the auto-judge path for ESCALATED deliberations:
//   - judgeProfileId  — which profile is spawned as the judge agent ("judge")
//   - judgeTimeoutMs  — per-judge wall-clock ceiling (10 min = 600_000 ms)
//   - escalationStrategy — "human" | "judge" | "hybrid"
//
// The voter-timeout and probe-cache fields each have their own companion test;
// these judge-escalation fields have only incidental coverage in the main suite.
// This file pins their defaults, override behaviour, and reset idempotency.

import { describe, it, expect, beforeEach } from "vitest";
import * as rc from "@zana-ai/work/src/deliberation/runtime-config.ts";

const JUDGE_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000; // 600_000 ms
const JUDGE_PROFILE_ID_DEFAULT = "judge";
const ESCALATION_STRATEGY_DEFAULT = "human";

beforeEach(() => {
  rc.resetRuntimeConfig();
});

describe("judgeTimeoutMs — judge-agent wall-clock ceiling", () => {
  it("default is exactly 10 min (600_000 ms)", () => {
    expect(rc.getRuntimeConfig().judgeTimeoutMs).toBe(JUDGE_TIMEOUT_DEFAULT_MS);
  });

  it("can be lowered for tests that use a tight timeout", () => {
    rc.setRuntimeConfig({ judgeTimeoutMs: 5_000 });
    expect(rc.getRuntimeConfig().judgeTimeoutMs).toBe(5_000);
  });

  it("can be raised above the default for slow environments", () => {
    rc.setRuntimeConfig({ judgeTimeoutMs: 30 * 60 * 1000 });
    expect(rc.getRuntimeConfig().judgeTimeoutMs).toBe(30 * 60 * 1000);
  });

  it("resetRuntimeConfig restores 10-min default after any override", () => {
    rc.setRuntimeConfig({ judgeTimeoutMs: 1_000 });
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().judgeTimeoutMs).toBe(JUDGE_TIMEOUT_DEFAULT_MS);
  });

  it("multiple override/reset cycles always converge to the 10-min default", () => {
    for (const ms of [500, 5_000, 60 * 60 * 1000, 0]) {
      rc.setRuntimeConfig({ judgeTimeoutMs: ms });
      rc.resetRuntimeConfig();
      expect(rc.getRuntimeConfig().judgeTimeoutMs).toBe(JUDGE_TIMEOUT_DEFAULT_MS);
    }
  });

  it("overriding judgeTimeoutMs leaves unrelated fields unchanged", () => {
    rc.setRuntimeConfig({ judgeTimeoutMs: 999 });
    const cfg = rc.getRuntimeConfig();
    expect(cfg.defaultRounds).toBe(2);
    expect(cfg.escalationStrategy).toBe(ESCALATION_STRATEGY_DEFAULT);
    expect(cfg.judgeProfileId).toBe(JUDGE_PROFILE_ID_DEFAULT);
    expect(cfg.voterTimeoutMs).toBe(20 * 60 * 1000);
  });
});

describe("judgeProfileId — profile resolved for auto-judge agent", () => {
  it("default is 'judge'", () => {
    expect(rc.getRuntimeConfig().judgeProfileId).toBe(JUDGE_PROFILE_ID_DEFAULT);
  });

  it("can be overridden to a custom profile id", () => {
    rc.setRuntimeConfig({ judgeProfileId: "senior-reviewer" });
    expect(rc.getRuntimeConfig().judgeProfileId).toBe("senior-reviewer");
  });

  it("resetRuntimeConfig restores the 'judge' default after override", () => {
    rc.setRuntimeConfig({ judgeProfileId: "other-profile" });
    rc.resetRuntimeConfig();
    expect(rc.getRuntimeConfig().judgeProfileId).toBe(JUDGE_PROFILE_ID_DEFAULT);
  });
});

describe("escalationStrategy — how ESCALATED deliberations are resolved", () => {
  it("default is 'human'", () => {
    expect(rc.getRuntimeConfig().escalationStrategy).toBe(ESCALATION_STRATEGY_DEFAULT);
  });

  it("can be set to 'judge'", () => {
    rc.setRuntimeConfig({ escalationStrategy: "judge" });
    expect(rc.getRuntimeConfig().escalationStrategy).toBe("judge");
  });

  it("can be set to 'hybrid'", () => {
    rc.setRuntimeConfig({ escalationStrategy: "hybrid" });
    expect(rc.getRuntimeConfig().escalationStrategy).toBe("hybrid");
  });

  it("resetRuntimeConfig restores 'human' after any strategy override", () => {
    for (const strategy of ["judge", "hybrid"] as const) {
      rc.setRuntimeConfig({ escalationStrategy: strategy });
      rc.resetRuntimeConfig();
      expect(rc.getRuntimeConfig().escalationStrategy).toBe(ESCALATION_STRATEGY_DEFAULT);
    }
  });

  it("overriding escalationStrategy leaves judgeProfileId and judgeTimeoutMs unchanged", () => {
    rc.setRuntimeConfig({ escalationStrategy: "judge" });
    const cfg = rc.getRuntimeConfig();
    expect(cfg.judgeProfileId).toBe(JUDGE_PROFILE_ID_DEFAULT);
    expect(cfg.judgeTimeoutMs).toBe(JUDGE_TIMEOUT_DEFAULT_MS);
  });

  it("all three judge-escalation fields can be overridden in a single setRuntimeConfig call", () => {
    rc.setRuntimeConfig({
      escalationStrategy: "judge",
      judgeProfileId: "custom-judge",
      judgeTimeoutMs: 5 * 60 * 1000,
    });
    const cfg = rc.getRuntimeConfig();
    expect(cfg.escalationStrategy).toBe("judge");
    expect(cfg.judgeProfileId).toBe("custom-judge");
    expect(cfg.judgeTimeoutMs).toBe(5 * 60 * 1000);
    // Non-judge fields stay at defaults
    expect(cfg.defaultRounds).toBe(2);
    expect(cfg.voterTimeoutMs).toBe(20 * 60 * 1000);
  });
});
