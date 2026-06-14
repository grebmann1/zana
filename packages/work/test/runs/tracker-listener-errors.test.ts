// Tests that notifyChange() and notifyStats() swallow listener errors without
// crashing and continue firing subsequent listeners.
//
// Invariants under test (tracker.ts notifyChange / notifyStats):
//   • A listener that throws must not propagate the error to the caller
//   • Listeners registered AFTER a throwing one must still be called
//   • The same resilience applies to onStatsUpdate callbacks

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hoist mock primitives so they're available inside vi.mock factories ────
const { fakeBus, fakeStatsEngine, EVENTS } = vi.hoisted(() => {
  const EVENTS = {
    TEAM_STARTED: "team:started",
    TEAM_STOPPED: "team:stopped",
    AGENT_SPAWNED: "agent:spawned",
    AGENT_TERMINATED: "agent:terminated",
    AGENT_HOOK: "agent:hook",
    RUN_STARTED: "run:started",
    RUN_ENDED: "run:ended",
  };
  const fakeBus = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
  const fakeStatsEngine = {
    computePeakConcurrentAgents: vi.fn(() => 0),
    computeProfileBreakdown: vi.fn(() => ({})),
    computeAgentTimeline: vi.fn(() => []),
    computeTicketFlow: vi.fn(() => []),
    computeThroughput: vi.fn(() => []),
  };
  return { fakeBus, fakeStatsEngine, EVENTS };
});

vi.mock("@zana-ai/work/src/runs/store.ts", () => ({
  saveRun: vi.fn(),
  getRun: vi.fn(() => null),
  listRuns: vi.fn(() => []),
}));

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus, EVENTS, stats: fakeStatsEngine },
  config: { ZANA_DIR: "/tmp/zana-test" },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn() }) } },
}));

import * as tracker from "@zana-ai/work/src/runs/tracker.ts";

function makeRunArgs(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-err",
    teamName: "Error Team",
    workspace: "/ws",
    daemonId: "daemon-err",
    orchestratorAgentId: null,
    ...overrides,
  };
}

describe("tracker — onChange listener error isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const stale = tracker.getCurrentRun();
    if (stale) tracker.endRun(stale.id);
  });

  afterEach(() => {
    const active = tracker.getCurrentRun();
    if (active) tracker.endRun(active.id);
    vi.useRealTimers();
  });

  it("does not throw when a registered onChange callback throws", () => {
    const throwing = vi.fn(() => { throw new Error("listener boom"); });
    const unsub = tracker.onChange(throwing);

    expect(() => tracker.startRun(makeRunArgs())).not.toThrow();
    unsub();
  });

  it("continues calling later listeners even if an earlier one throws", () => {
    const throwing = vi.fn(() => { throw new Error("first listener boom"); });
    const safe = vi.fn();

    const unsub1 = tracker.onChange(throwing);
    const unsub2 = tracker.onChange(safe);

    tracker.startRun(makeRunArgs());

    expect(throwing).toHaveBeenCalled();
    expect(safe).toHaveBeenCalled();

    unsub1();
    unsub2();
  });
});

describe("tracker — onStatsUpdate listener error isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const stale = tracker.getCurrentRun();
    if (stale) tracker.endRun(stale.id);
  });

  afterEach(() => {
    const active = tracker.getCurrentRun();
    if (active) tracker.endRun(active.id);
    vi.useRealTimers();
  });

  it("does not throw when a registered onStatsUpdate callback throws", () => {
    const throwing = vi.fn(() => { throw new Error("stats listener boom"); });
    const unsub = tracker.onStatsUpdate(throwing);

    tracker.startRun(makeRunArgs());
    // The live-stats interval fires every 5000 ms.
    expect(() => vi.advanceTimersByTime(5_001)).not.toThrow();

    unsub();
  });

  it("continues calling later onStatsUpdate listeners even if an earlier one throws", () => {
    const throwing = vi.fn(() => { throw new Error("stats boom"); });
    const safe = vi.fn();

    const unsub1 = tracker.onStatsUpdate(throwing);
    const unsub2 = tracker.onStatsUpdate(safe);

    tracker.startRun(makeRunArgs());
    vi.advanceTimersByTime(5_001);

    expect(throwing).toHaveBeenCalled();
    expect(safe).toHaveBeenCalled();

    unsub1();
    unsub2();
  });
});
