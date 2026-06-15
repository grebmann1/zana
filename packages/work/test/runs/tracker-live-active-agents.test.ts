// Tests that getLiveStats().activeAgents reflects the live agent roster driven
// by the AGENT_SPAWNED / AGENT_TERMINATED bus handlers registered in
// tracker.init().
//
// tracker.ts:
//   • AGENT_SPAWNED   → pushes an agent entry (terminatedAt: null) onto the run
//   • AGENT_TERMINATED→ sets that agent's terminatedAt
//   • getLiveStats()  → activeAgents = agents.filter(a => !a.terminatedAt).length
//
// The existing tracker.test.ts getLiveStats suite only asserts the *type* of
// activeAgents; no test exercises the spawn→terminate count transition through
// the real bus. Same mock/real-bus pattern as tracker-team-events.test.ts.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

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

describe("tracker — getLiveStats activeAgents via spawn/terminate bus events", () => {
  let realBus: any;

  // init() registers on the real bus; call once to avoid duplicate handlers.
  beforeAll(async () => {
    const realCore = (await vi.importActual("@zana-ai/core")) as any;
    realBus = realCore.events.bus;
    tracker.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const stale = tracker.getCurrentRun();
    if (stale) tracker.endRun(stale.id);
  });

  afterEach(() => {
    const active = tracker.getCurrentRun();
    if (active) tracker.endRun(active.id);
  });

  it("counts only non-terminated agents and decrements when one terminates", () => {
    tracker.startRun({
      teamId: "t-live",
      teamName: "Live Team",
      workspace: "/ws",
      daemonId: "d1",
      orchestratorAgentId: null, // non-orchestrator → no auto-end on terminate
    });

    // No agents yet.
    expect(tracker.getLiveStats()!.activeAgents).toBe(0);

    realBus.emit("agent:spawned", { agentId: "a-1", profileId: "coder" });
    realBus.emit("agent:spawned", { agentId: "a-2", profileId: "tester" });

    expect(tracker.getCurrentRun()!.agents).toHaveLength(2);
    expect(tracker.getLiveStats()!.activeAgents).toBe(2);

    // Terminate one — activeAgents drops, but the roster size stays at 2.
    realBus.emit("agent:terminated", { agentId: "a-1", reason: "completed" });

    expect(tracker.getLiveStats()!.activeAgents).toBe(1);
    expect(tracker.getCurrentRun()!.agents).toHaveLength(2);
  });

  it("ignores agent:spawned events when no run is active", () => {
    expect(tracker.getCurrentRun()).toBeNull();

    // Must not throw and must not implicitly create a run.
    realBus.emit("agent:spawned", { agentId: "orphan", profileId: "coder" });

    expect(tracker.getCurrentRun()).toBeNull();
    expect(tracker.getLiveStats()).toBeNull();
  });
});
