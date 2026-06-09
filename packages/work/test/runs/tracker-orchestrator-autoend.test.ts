// Tests for the orchestrator auto-end logic in tracker.init().
//
// When `orchestratorAgentId` is set on the active run and `agent:terminated`
// fires for that agent, the tracker schedules a setTimeout(3 s) to call
// endRun.  The real bus is required because the _core() dynamic require()
// inside tracker.ts bypasses vi.mock() — same pattern as
// tracker-hook-tracking.test.ts.
//
// Covered behaviours:
//   • Run auto-ends 3 s after the orchestrator agent terminates normally
//   • Run auto-ends with status "errored" when orchestrator reason is "errored"
//   • Non-orchestrator termination does NOT trigger auto-end

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// ── hoist mock primitives so they are available inside vi.mock factories ──────
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

function makeRunArgs(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-orch",
    teamName: "Orch Team",
    workspace: "/ws",
    daemonId: "daemon-orch",
    orchestratorAgentId: null,
    ...overrides,
  };
}

describe("tracker — orchestrator agent auto-end", () => {
  let realBus: any;

  // init() registers listeners on the real bus via the dynamic require()
  // inside _core() — call it once so we don't accumulate duplicate handlers.
  beforeAll(async () => {
    const realCore = (await vi.importActual("@zana-ai/core")) as any;
    realBus = realCore.events.bus;
    tracker.init();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const stale = tracker.getCurrentRun();
    if (stale) tracker.endRun(stale.id);
  });

  afterEach(() => {
    // Flush any pending timers, then manually end a leftover run so tests
    // don't bleed state into each other.
    vi.clearAllTimers();
    const active = tracker.getCurrentRun();
    if (active) tracker.endRun(active.id);
    vi.useRealTimers();
  });

  it("run is still active immediately after orchestrator termination (deferred)", () => {
    tracker.startRun(makeRunArgs({ orchestratorAgentId: "orch-1" }));

    realBus.emit("agent:terminated", { agentId: "orch-1", reason: "completed" });

    // The setTimeout hasn't fired yet — run must still be alive.
    expect(tracker.getCurrentRun()).not.toBeNull();
  });

  it("auto-ends run 3 s after orchestrator terminates with status 'completed'", () => {
    tracker.startRun(makeRunArgs({ orchestratorAgentId: "orch-2" }));

    realBus.emit("agent:terminated", { agentId: "orch-2", reason: "completed" });
    vi.advanceTimersByTime(3000);

    expect(tracker.getCurrentRun()).toBeNull();
    // The last saveRun call should carry status "completed".
    const saveCalls = (store.saveRun as ReturnType<typeof vi.fn>).mock.calls;
    const lastSaved = saveCalls[saveCalls.length - 1]?.[0];
    expect(lastSaved?.status).toBe("completed");
  });

  it("auto-ends run with status 'errored' when orchestrator exits with reason 'errored'", () => {
    tracker.startRun(makeRunArgs({ orchestratorAgentId: "orch-err" }));

    realBus.emit("agent:terminated", { agentId: "orch-err", reason: "errored" });
    vi.advanceTimersByTime(3000);

    expect(tracker.getCurrentRun()).toBeNull();
    const saveCalls = (store.saveRun as ReturnType<typeof vi.fn>).mock.calls;
    const lastSaved = saveCalls[saveCalls.length - 1]?.[0];
    expect(lastSaved?.status).toBe("errored");
  });

  it("does NOT auto-end when a non-orchestrator agent terminates", () => {
    const run = tracker.startRun(makeRunArgs({ orchestratorAgentId: "orch-main" }));

    realBus.emit("agent:terminated", { agentId: "worker-side", reason: "completed" });
    vi.advanceTimersByTime(5000);

    // The run should still be alive — only the orchestrator triggers auto-end.
    expect(tracker.getCurrentRun()).not.toBeNull();
    expect(tracker.getCurrentRun()!.id).toBe(run.id);
  });
});
