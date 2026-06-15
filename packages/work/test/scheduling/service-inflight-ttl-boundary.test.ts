// Scheduler service — inflight TTL sweep BOUNDARY.
//
// sweepInflightAgents() prunes entries whose age STRICTLY exceeds
// INFLIGHT_TTL_MS (6 min): `now - spawnedAt > INFLIGHT_TTL_MS`. The existing
// suite covers "clearly old" (TTL + 1s) and "clearly fresh", but not the exact
// boundary — the one place an off-by-one (`>=` vs `>`) would hide. We freeze
// the clock with fake timers so Date.now() is identical at track-time and
// sweep-time, making the boundary deterministic rather than racy.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";

const INFLIGHT_TTL_MS = 6 * 60 * 1000;

describe("scheduler service — inflight TTL sweep boundary", () => {
  beforeEach(() => {
    // The inflight Map is module-level; drain leftovers from prior tests by
    // aging every entry past the TTL and sweeping before we install fake time.
    for (const e of (schedulerService as any)._getInflightAgentsForTest()) {
      (schedulerService as any)._trackAgentForTest(e.agentId, e.scheduleId, 0);
    }
    schedulerService.sweepInflightAgents();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps an entry aged EXACTLY at the TTL (strict > comparison, not >=)", () => {
    const now = Date.now();
    // age == INFLIGHT_TTL_MS  →  now - spawnedAt is NOT > TTL  →  kept.
    (schedulerService as any)._trackAgentForTest(
      "agent-at-boundary",
      "sched-boundary",
      now - INFLIGHT_TTL_MS,
    );

    expect(schedulerService.sweepInflightAgents()).toBe(0);

    const after = (schedulerService as any)._getInflightAgentsForTest();
    expect(after).toHaveLength(1);
    expect(after[0].agentId).toBe("agent-at-boundary");
  });

  it("prunes an entry one millisecond past the TTL", () => {
    const now = Date.now();
    // age == INFLIGHT_TTL_MS + 1  →  strictly greater  →  pruned.
    (schedulerService as any)._trackAgentForTest(
      "agent-past-boundary",
      "sched-boundary",
      now - INFLIGHT_TTL_MS - 1,
    );

    expect(schedulerService.sweepInflightAgents()).toBe(1);
    expect((schedulerService as any)._getInflightAgentsForTest()).toHaveLength(0);
  });

  it("returns 0 and is a no-op on an empty inflight map", () => {
    expect((schedulerService as any)._getInflightAgentsForTest()).toHaveLength(0);
    expect(schedulerService.sweepInflightAgents()).toBe(0);
  });
});
