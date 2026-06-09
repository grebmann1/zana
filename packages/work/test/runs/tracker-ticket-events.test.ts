// Tests for the ticket:created and ticket:completed bus event handlers
// registered inside tracker.init().
//
// None of the existing tracker test files emit these events, so the
// ticket-tracking logic in tracker.ts lines 105-118 is untested.
//
// init() binds handlers to the REAL EventEmitter bus via the dynamic
// _core() / _bus() helper — vi.mock("@zana-ai/core") does NOT intercept
// dynamic require() calls.  We obtain the real bus via vi.importActual
// (the same pattern used by tracker-hook-tracking.test.ts and
// tracker-stats.test.ts) and emit directly on it.
//
// Covered behaviours:
//   • ticket:created increments tickets.total
//   • ticket:created pushes ticketId into tickets.ids when present
//   • ticket:created does NOT push to tickets.ids when ticketId is absent
//   • ticket:completed increments tickets.completed
//   • ticket:created and ticket:completed are no-ops when no run is active
//   • ticket:created fires onChange listeners (notifyChange path)

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// ── hoist mock primitives (must be resolvable inside vi.mock factories) ────────
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
    teamId: "team-ticket-events",
    teamName: "Ticket Events Team",
    workspace: "/ws",
    daemonId: "daemon-ticket-events",
    orchestratorAgentId: null,
    ...overrides,
  };
}

describe("tracker — ticket:created / ticket:completed bus handlers", () => {
  let realBus: any;

  // Register init() once — calling it multiple times accumulates duplicate
  // handlers on the real bus and inflates counts.
  beforeAll(async () => {
    const realCore = await vi.importActual("@zana-ai/core") as any;
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
    const active = tracker.getCurrentRun();
    if (active) tracker.endRun(active.id);
    vi.useRealTimers();
  });

  // ── ticket:created ──────────────────────────────────────────────────────────

  it("ticket:created increments tickets.total", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("ticket:created", { ticketId: "T-1" });
    realBus.emit("ticket:created", { ticketId: "T-2" });

    expect(run.tickets.total).toBe(2);
  });

  it("ticket:created pushes ticketId into tickets.ids when present", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("ticket:created", { ticketId: "T-abc" });

    expect(run.tickets.ids).toContain("T-abc");
    expect(run.tickets.ids).toHaveLength(1);
  });

  it("ticket:created does NOT push to tickets.ids when ticketId is absent", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("ticket:created", {}); // no ticketId field

    expect(run.tickets.total).toBe(1); // still counted
    expect(run.tickets.ids).toHaveLength(0); // but NOT pushed
  });

  it("ticket:created accumulates multiple ticket IDs in order", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("ticket:created", { ticketId: "T-1" });
    realBus.emit("ticket:created", { ticketId: "T-2" });
    realBus.emit("ticket:created", { ticketId: "T-3" });

    expect(run.tickets.total).toBe(3);
    expect(run.tickets.ids).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("ticket:created fires onChange listeners via notifyChange", () => {
    const cb = vi.fn();
    tracker.startRun(makeRunArgs());
    const unsub = tracker.onChange(cb);

    realBus.emit("ticket:created", { ticketId: "T-notify" });

    expect(cb).toHaveBeenCalled();
    unsub();
  });

  it("ticket:created is a no-op when no run is active", () => {
    // Ensure no run is active
    expect(tracker.getCurrentRun()).toBeNull();

    // Should not throw
    realBus.emit("ticket:created", { ticketId: "T-orphan" });

    expect(tracker.getCurrentRun()).toBeNull();
  });

  // ── ticket:completed ────────────────────────────────────────────────────────

  it("ticket:completed increments tickets.completed", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("ticket:created", { ticketId: "T-10" });
    realBus.emit("ticket:completed", { ticketId: "T-10" });

    expect(run.tickets.completed).toBe(1);
  });

  it("ticket:completed increments independently of tickets.total", () => {
    const run = tracker.startRun(makeRunArgs());

    realBus.emit("ticket:created", { ticketId: "T-a" });
    realBus.emit("ticket:created", { ticketId: "T-b" });
    realBus.emit("ticket:completed", { ticketId: "T-a" });

    expect(run.tickets.total).toBe(2);
    expect(run.tickets.completed).toBe(1);
  });

  it("ticket:completed is a no-op when no run is active", () => {
    expect(tracker.getCurrentRun()).toBeNull();

    // Should not throw
    realBus.emit("ticket:completed", { ticketId: "T-ghost" });

    expect(tracker.getCurrentRun()).toBeNull();
  });
});
