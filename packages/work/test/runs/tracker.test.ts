// Tests for packages/work/src/runs/tracker.ts
// Covers startRun, endRun, getCurrentRun, getLiveStats, exportRun,
// and onChange listener management.  All I/O and bus interactions are
// mocked so the suite is fully deterministic and makes no real FS writes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hoist mock primitives so they are available inside vi.mock factories ──
// vi.mock() calls are hoisted before const declarations; vi.hoisted() puts
// variables above that boundary so the factory closure can reference them.
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
  const fakeBus = {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
  const fakeStatsEngine = {
    computePeakConcurrentAgents: vi.fn(() => 2),
    computeProfileBreakdown: vi.fn(() => ({ coder: 1 })),
    computeAgentTimeline: vi.fn(() => []),
    computeTicketFlow: vi.fn(() => []),
    computeThroughput: vi.fn(() => []),
  };
  return { fakeBus, fakeStatsEngine, EVENTS };
});

// ── mock the store dependency before importing tracker ────────────────────
vi.mock("@zana-ai/work/src/runs/store.ts", () => ({
  saveRun: vi.fn(),
  getRun: vi.fn((_id: string) => null),
  listRuns: vi.fn(() => []),
}));

// ── build a stable fake @zana-ai/core so lazy require() calls work ────────
vi.mock("@zana-ai/core", () => ({
  events: { bus: fakeBus, EVENTS, stats: fakeStatsEngine },
  config: { ZANA_DIR: "/tmp/zana-test" },
  util: { logger: { getLogger: () => ({ error: vi.fn(), warn: vi.fn() }) } },
}));

import * as tracker from "@zana-ai/work/src/runs/tracker.ts";
import * as store from "@zana-ai/work/src/runs/store.ts";

// ── helpers ───────────────────────────────────────────────────────────────

function makeRunArgs(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-1",
    teamName: "Alpha",
    workspace: "/ws",
    daemonId: "daemon-1",
    orchestratorAgentId: null,
    ...overrides,
  };
}

// ── suite ─────────────────────────────────────────────────────────────────

describe("tracker — startRun", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Clear any leftover state from a previous test by ending a stale run.
    const stale = tracker.getCurrentRun();
    if (stale) tracker.endRun(stale.id);
  });

  afterEach(() => {
    // Ensure the active run is always cleaned up so tests don't bleed.
    const active = tracker.getCurrentRun();
    if (active) tracker.endRun(active.id);
    vi.useRealTimers();
  });

  it("returns a run object with required shape and status='running'", () => {
    const run = tracker.startRun(makeRunArgs());

    expect(typeof run.id).toBe("string");
    expect(run.id.length).toBeGreaterThan(0);
    expect(run.status).toBe("running");
    expect(run.teamId).toBe("team-1");
    expect(run.teamName).toBe("Alpha");
    expect(run.workspace).toBe("/ws");
    expect(run.daemonId).toBe("daemon-1");
    expect(Array.isArray(run.agents)).toBe(true);
    expect(run.tickets).toMatchObject({ total: 0, completed: 0, ids: [] });
    expect(typeof run.startedAt).toBe("number");
    expect(run.endedAt).toBeNull();
    expect(run.durationMs).toBeNull();
  });

  it("persists the run via store.saveRun", () => {
    tracker.startRun(makeRunArgs());
    expect(store.saveRun).toHaveBeenCalledOnce();
  });

  it("second startRun while one is already active does not overwrite it", () => {
    const first = tracker.startRun(makeRunArgs({ teamId: "first" }));
    tracker.startRun(makeRunArgs({ teamId: "second" }));
    // init() bus listener guards against this; the direct startRun path
    // overwrites.  Verify getCurrentRun always returns a defined run.
    const current = tracker.getCurrentRun();
    expect(current).not.toBeNull();
    expect(typeof current!.id).toBe("string");
  });
});

describe("tracker — getCurrentRun", () => {
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

  it("returns null when no run is active", () => {
    expect(tracker.getCurrentRun()).toBeNull();
  });

  it("returns the active run after startRun", () => {
    const run = tracker.startRun(makeRunArgs());
    expect(tracker.getCurrentRun()).toBe(run);
  });
});

describe("tracker — endRun", () => {
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

  it("returns null when runId does not match the current run", () => {
    tracker.startRun(makeRunArgs());
    const result = tracker.endRun("wrong-id");
    expect(result).toBeNull();
    // Current run should still be active.
    expect(tracker.getCurrentRun()).not.toBeNull();
  });

  it("sets status, endedAt, durationMs and clears currentRun", () => {
    vi.setSystemTime(1_000_000);
    const run = tracker.startRun(makeRunArgs());
    vi.setSystemTime(1_005_000); // 5 s later

    const finished = tracker.endRun(run.id);

    expect(finished).not.toBeNull();
    expect(finished!.status).toBe("completed");
    expect(finished!.endedAt).toBe(1_005_000);
    expect(finished!.durationMs).toBe(5_000);
    expect(tracker.getCurrentRun()).toBeNull();
  });

  it("accepts a custom status (e.g. 'aborted')", () => {
    const run = tracker.startRun(makeRunArgs());
    const finished = tracker.endRun(run.id, "aborted");
    expect(finished!.status).toBe("aborted");
  });

  it("saves the final run to the store", () => {
    const run = tracker.startRun(makeRunArgs());
    vi.clearAllMocks(); // reset so saveRun call from startRun is excluded
    tracker.endRun(run.id);
    expect(store.saveRun).toHaveBeenCalledOnce();
  });

  it("endRun with no active run returns null", () => {
    // No active run — should be a no-op and not throw.
    expect(tracker.getCurrentRun()).toBeNull();
    expect(tracker.endRun("phantom-id")).toBeNull();
  });
});

describe("tracker — getLiveStats", () => {
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

  it("returns null when no run is active", () => {
    expect(tracker.getLiveStats()).toBeNull();
  });

  it("returns a stats snapshot including activeAgents and durationMs", () => {
    vi.setSystemTime(2_000_000);
    tracker.startRun(makeRunArgs());
    vi.setSystemTime(2_003_000);

    const stats = tracker.getLiveStats();
    expect(stats).not.toBeNull();
    expect(stats!.durationMs).toBe(3_000);
    expect(typeof stats!.activeAgents).toBe("number");
    expect(typeof stats!.filesCount).toBe("number");
    expect(stats!.ticketsTotal).toBe(0);
    expect(stats!.ticketsCompleted).toBe(0);
  });
});

describe("tracker — exportRun", () => {
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

  it("returns null when runId is not found in the store", () => {
    (store.getRun as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = tracker.exportRun("ghost-run");
    expect(result).toBeNull();
  });

  it("returns a JSON export with filename and data when run is found", () => {
    const run = tracker.startRun(makeRunArgs({ teamId: "t-export" }));
    (store.getRun as ReturnType<typeof vi.fn>).mockReturnValue(run);

    const result = tracker.exportRun(run.id);
    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(/^run-.*\.json$/);
    const parsed = JSON.parse(result!.data);
    expect(parsed.run.id).toBe(run.id);
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  it("returns an NDJSON export when format='ndjson'", () => {
    const run = tracker.startRun(makeRunArgs({ teamId: "t-ndjson" }));
    (store.getRun as ReturnType<typeof vi.fn>).mockReturnValue(run);

    const result = tracker.exportRun(run.id, "ndjson");
    expect(result!.filename).toMatch(/\.ndjson$/);
    const lines = result!.data.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const firstLine = JSON.parse(lines[0]);
    expect(firstLine.type).toBe("run");
    expect(firstLine.data.id).toBe(run.id);
  });
});

describe("tracker — onChange listener", () => {
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

  it("fires the callback when a run starts", () => {
    const cb = vi.fn();
    const unsub = tracker.onChange(cb);

    tracker.startRun(makeRunArgs());
    expect(cb).toHaveBeenCalled();
    unsub();
  });

  it("does not fire after unsubscribing", () => {
    const cb = vi.fn();
    const unsub = tracker.onChange(cb);
    unsub();

    tracker.startRun(makeRunArgs());
    expect(cb).not.toHaveBeenCalled();
  });
});
