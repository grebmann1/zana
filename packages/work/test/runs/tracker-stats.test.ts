// Tests for the three untested exports of packages/work/src/runs/tracker.ts:
//   • getRunStats(runId)   — reads from store and returns run.stats
//   • getRunTimeline(runId) — returns computed timeline for the active run;
//                             empty arrays for non-active / unknown run IDs
//   • onStatsUpdate(cb)    — push-notification listener; unsubscribe works
//
// All I/O and bus calls are mocked — deterministic, no real FS writes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hoist mock primitives (must be available inside vi.mock factories) ──────
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
    computeAgentTimeline: vi.fn(() => [{ agentId: "a1" }]),
    computeTicketFlow: vi.fn(() => [{ t: 1 }]),
    computeThroughput: vi.fn(() => [{ rate: 5 }]),
  };
  return { fakeBus, fakeStatsEngine, EVENTS };
});

vi.mock("@zana-ai/work/src/runs/store.ts", () => ({
  saveRun: vi.fn(),
  getRun: vi.fn((_id: string) => null),
  listRuns: vi.fn(() => []),
}));

vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus, EVENTS, stats: fakeStatsEngine },
  config: { ZANA_DIR: "/tmp/zana-test" },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn() }) } },
}));

import * as tracker from "@zana-ai/work/src/runs/tracker.ts";
import * as store from "@zana-ai/work/src/runs/store.ts";

// ── shared helper ─────────────────────────────────────────────────────────────
function makeRunArgs(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-stats",
    teamName: "Stats Team",
    workspace: "/ws",
    daemonId: "daemon-stats",
    orchestratorAgentId: null,
    ...overrides,
  };
}

// ── getRunStats ───────────────────────────────────────────────────────────────

describe("tracker — getRunStats", () => {
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

  it("returns null when the store has no matching run", () => {
    (store.getRun as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(tracker.getRunStats("nonexistent")).toBeNull();
  });

  it("returns run.stats when the store has a matching run", () => {
    const fakeStats = {
      totalAgents: 3,
      peakConcurrentAgents: 2,
      totalToolCalls: 12,
      toolBreakdown: { Write: 5, Read: 7 },
      profileBreakdown: {},
      ticketCompletionRate: 0.5,
      eventCount: 20,
    };
    (store.getRun as ReturnType<typeof vi.fn>).mockReturnValue({ id: "r1", stats: fakeStats });

    const result = tracker.getRunStats("r1");
    expect(result).toStrictEqual(fakeStats);
  });
});

// ── getRunTimeline ────────────────────────────────────────────────────────────

describe("tracker — getRunTimeline", () => {
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

  it("returns empty arrays for an unknown runId (not the current run)", () => {
    const result = tracker.getRunTimeline("ghost-run");
    expect(result).toStrictEqual({ agentTimeline: [], ticketFlow: [], throughput: [] });
  });

  it("returns computed timeline data when queried for the current run", async () => {
    // vi.mock("@zana-ai/core") intercepts ESM imports but NOT the dynamic
    // require() inside tracker.ts's _core() helper — so init() registers its
    // AGENT_SPAWNED handler on the real EventEmitter bus, not on fakeBus.
    // Use vi.importActual to get the real bus and emit on it directly so that
    // the handler fires synchronously and runEvents is populated before
    // getRunTimeline is called.
    const realCore = await vi.importActual("@zana-ai/core") as any;

    tracker.init();
    const run = tracker.startRun(makeRunArgs());

    // Emit on the real bus — synchronous EventEmitter dispatch, so runEvents
    // has the agent:spawned entry before getRunTimeline is called.
    realCore.events.bus.emit("agent:spawned", { agentId: "a1", profileId: "researcher" });

    const result = tracker.getRunTimeline(run.id);

    // Real stats engine computes a bucket timeline from the spawn event —
    // result must NOT be the hardcoded empty-arrays fallback path.
    expect(Array.isArray(result.agentTimeline)).toBe(true);
    expect(result.agentTimeline.length).toBeGreaterThan(0);
    expect(Array.isArray(result.ticketFlow)).toBe(true);
    expect(Array.isArray(result.throughput)).toBe(true);
  });

  it("returns empty arrays after the current run ends (different runId)", () => {
    const run = tracker.startRun(makeRunArgs());
    tracker.endRun(run.id);

    // After endRun, currentRun is null — querying the old id should give empty arrays.
    const result = tracker.getRunTimeline(run.id);
    expect(result).toStrictEqual({ agentTimeline: [], ticketFlow: [], throughput: [] });
  });
});

// ── onStatsUpdate ─────────────────────────────────────────────────────────────

describe("tracker — onStatsUpdate listener", () => {
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

  it("fires the callback when the live-stats interval ticks", () => {
    const cb = vi.fn();
    const unsub = tracker.onStatsUpdate(cb);

    tracker.startRun(makeRunArgs());
    // The live-stats interval fires every 5000 ms.
    vi.advanceTimersByTime(5_001);

    expect(cb).toHaveBeenCalled();
    // The argument should look like a live-stats snapshot.
    const snapshot = cb.mock.calls[0][0];
    expect(typeof snapshot.durationMs).toBe("number");

    unsub();
  });

  it("does not fire after the listener is unsubscribed", () => {
    const cb = vi.fn();
    const unsub = tracker.onStatsUpdate(cb);
    unsub();

    tracker.startRun(makeRunArgs());
    vi.advanceTimersByTime(10_001);

    expect(cb).not.toHaveBeenCalled();
  });
});
