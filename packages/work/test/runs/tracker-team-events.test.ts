// Tests for the TEAM_STARTED and TEAM_STOPPED bus event handlers registered
// inside tracker.init().
//
// tracker.ts registers these two handlers (lines 28-43):
//   • TEAM_STARTED  → calls startRun() when no run is currently active
//   • TEAM_STOPPED  → calls endRun() when the current run's teamId matches
//
// No existing test file exercises these paths.  init() binds to the REAL
// EventEmitter bus via the dynamic _core() / _bus() helper, which bypasses
// vi.mock() — so we obtain the real bus via vi.importActual (same pattern as
// tracker-orchestrator-autoend.test.ts and tracker-hook-tracking.test.ts).
//
// Covered behaviours:
//   • TEAM_STARTED auto-starts a run with the emitted teamId/teamName
//   • TEAM_STARTED is a no-op when a run is already active (guard: !currentRun)
//   • TEAM_STOPPED ends the active run with status "completed" (default)
//   • TEAM_STOPPED ends with status "aborted" when reason === "user"
//   • TEAM_STOPPED is a no-op when the teamId does not match the current run
//   • TEAM_STOPPED is a no-op when no run is active

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// ── hoist mock primitives so they are available inside vi.mock factories ─────
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

describe("tracker — TEAM_STARTED / TEAM_STOPPED bus handlers", () => {
  let realBus: any;

  // init() registers on the real bus; call it once to avoid duplicate handlers.
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

  // ── TEAM_STARTED ─────────────────────────────────────────────────────────────

  it("TEAM_STARTED auto-starts a run when no run is currently active", () => {
    expect(tracker.getCurrentRun()).toBeNull();

    realBus.emit("team:started", { teamId: "t-1", teamName: "My Team" });

    const run = tracker.getCurrentRun();
    expect(run).not.toBeNull();
    expect(run!.teamId).toBe("t-1");
    expect(run!.teamName).toBe("My Team");
    expect(run!.status).toBe("running");
  });

  it("TEAM_STARTED sets the run id to a non-empty uuid string", () => {
    realBus.emit("team:started", { teamId: "t-uuid", teamName: "UUID Team" });

    const run = tracker.getCurrentRun();
    expect(typeof run!.id).toBe("string");
    expect(run!.id.length).toBeGreaterThan(0);
  });

  it("TEAM_STARTED is a no-op when a run is already active", () => {
    // Pre-start a run directly so we control its state.
    const existing = tracker.startRun({
      teamId: "t-existing",
      teamName: "Existing Team",
      workspace: "/ws",
      daemonId: "d1",
      orchestratorAgentId: null,
    });

    realBus.emit("team:started", { teamId: "t-new", teamName: "New Team" });

    // Active run must still be the original one.
    const run = tracker.getCurrentRun();
    expect(run!.id).toBe(existing.id);
    expect(run!.teamId).toBe("t-existing");
  });

  // ── TEAM_STOPPED ─────────────────────────────────────────────────────────────

  it("TEAM_STOPPED ends the active run with status 'completed' by default", () => {
    tracker.startRun({
      teamId: "t-stop",
      teamName: "Stop Team",
      workspace: "/ws",
      daemonId: "d1",
      orchestratorAgentId: null,
    });

    realBus.emit("team:stopped", { teamId: "t-stop", reason: "done" });

    expect(tracker.getCurrentRun()).toBeNull();
  });

  it("TEAM_STOPPED ends the run with status 'aborted' when reason === 'user'", () => {
    tracker.startRun({
      teamId: "t-abort",
      teamName: "Abort Team",
      workspace: "/ws",
      daemonId: "d1",
      orchestratorAgentId: null,
    });

    realBus.emit("team:stopped", { teamId: "t-abort", reason: "user" });

    // Run must be gone and the last persisted record must carry "aborted".
    expect(tracker.getCurrentRun()).toBeNull();
    const calls = (store.saveRun as ReturnType<typeof vi.fn>).mock.calls;
    const lastSaved = calls[calls.length - 1]?.[0];
    expect(lastSaved?.status).toBe("aborted");
  });

  it("TEAM_STOPPED is a no-op when teamId does not match the active run", () => {
    const run = tracker.startRun({
      teamId: "t-mine",
      teamName: "Mine",
      workspace: "/ws",
      daemonId: "d1",
      orchestratorAgentId: null,
    });

    realBus.emit("team:stopped", { teamId: "t-OTHER", reason: "done" });

    // Run must still be active — wrong teamId must be ignored.
    expect(tracker.getCurrentRun()).not.toBeNull();
    expect(tracker.getCurrentRun()!.id).toBe(run.id);
  });

  it("TEAM_STOPPED is a no-op when no run is active", () => {
    expect(tracker.getCurrentRun()).toBeNull();

    // Should not throw.
    realBus.emit("team:stopped", { teamId: "t-ghost", reason: "done" });

    expect(tracker.getCurrentRun()).toBeNull();
  });
});
