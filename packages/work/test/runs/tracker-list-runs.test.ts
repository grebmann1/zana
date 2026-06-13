// Tests for tracker.listRuns — the thin store-delegation export.
//
// `tracker.listRuns(opts)` is the only public function in tracker.ts that has
// zero coverage across all existing test files: every file mocks listRuns in
// the store but never calls tracker.listRuns().  This suite verifies:
//   1. It returns whatever the store returns (pass-through of results).
//   2. The `opts` object is forwarded verbatim to the store.
//   3. An undefined / empty opts is tolerated (no throw).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hoist mock primitives ─────────────────────────────────────────────────────
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
import * as store from "@zana-ai/work/src/runs/store.ts";

describe("tracker — listRuns", () => {
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

  it("returns the array the store provides", () => {
    const fakeRuns = [
      { id: "r1", status: "completed" },
      { id: "r2", status: "errored" },
    ];
    (store.listRuns as ReturnType<typeof vi.fn>).mockReturnValue(fakeRuns);

    const result = tracker.listRuns({});
    expect(result).toStrictEqual(fakeRuns);
  });

  it("returns an empty array when the store has no runs", () => {
    (store.listRuns as ReturnType<typeof vi.fn>).mockReturnValue([]);
    expect(tracker.listRuns({})).toStrictEqual([]);
  });

  it("forwards the opts object to the store", () => {
    const opts = { teamId: "team-x", limit: 10 };
    tracker.listRuns(opts);
    expect(store.listRuns).toHaveBeenCalledWith(opts);
  });

  it("tolerates undefined opts without throwing", () => {
    (store.listRuns as ReturnType<typeof vi.fn>).mockReturnValue([]);
    expect(() => tracker.listRuns(undefined)).not.toThrow();
    expect(store.listRuns).toHaveBeenCalledWith(undefined);
  });
});
