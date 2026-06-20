// Characterization test for sweeper.ts start() re-entrancy.
//
// Every existing start() suite calls start() exactly once. None pins what
// happens when start() is invoked a SECOND time while the sweeper is already
// running. The current implementation (sweeper.ts ~217) does an unconditional
//
//     timer = setInterval(...)
//
// with NO guard against an already-armed timer. So a second start():
//   1. runs another immediate synchronous sweep, and
//   2. arms a SECOND interval — overwriting the module-level `timer` handle and
//      ORPHANING the first interval, which can never be cleared again.
//
// Consequence (a latent defect, see the watcher report): a single stop() clears
// only the second timer, so `_isRunning()` reports false while the orphaned
// FIRST timer keeps sweeping on every tick — a leaked timer with no off switch.
//
// This test LOCKS that observed behavior so the leak is regression-visible. If
// start() is later hardened to be idempotent (e.g. early-return or clear the
// prior timer when already running), THIS TEST SHOULD BE UPDATED to assert the
// fixed behavior (afterOneTick === 1 and afterStopTicks === 1). It is a
// known-defect characterization test, not a statement that the leak is desired.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@zana-ai/core", () => ({
  modules: { config: { get: () => null } },
  agents: { manager: { listAgents: () => [] } },
  events: { bus: { emit: vi.fn() } },
}));

import {
  start,
  stop,
  _isRunning,
  _setTestSeams,
  _resetTestSeams,
} from "@zana-ai/work/src/tickets/sweeper.ts";

const HOUR = 60 * 60 * 1000;
const INTERVAL_MS = 1000;
const FIXED_NOW = Date.parse("2026-06-10T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  // Best-effort teardown. Note: a single stop() cannot clear the orphaned
  // timer this test creates, so we also restore real timers to kill it.
  stop();
  vi.useRealTimers();
  _resetTestSeams();
});

describe("sweepOnce lifecycle — double start() leaks the first interval timer", () => {
  it("arms a second timer on re-start, and the orphaned first timer survives stop()", () => {
    const staleTs = new Date(FIXED_NOW - 30 * HOUR).toISOString();
    const ticket = {
      id: "T-double-start",
      status: "blocked", // time-only rule → swept regardless of assignee
      assigneeId: null,
      assigneeName: null,
      audit: [{ timestamp: staleTs }],
      createdAt: staleTs,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "blocked" ? [ticket] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn(() => ({})) as any,
      bus: { emit: vi.fn() },
      configReader: () => ({ ticketSweeperIntervalMs: INTERVAL_MS }),
    });

    start(); // initial synchronous sweep #1 + arm timer A
    start(); // initial synchronous sweep #2 + arm timer B (timer A orphaned)

    // Two immediate sweeps — one per start() call.
    expect(updateStatus).toHaveBeenCalledTimes(2);
    expect(_isRunning()).toBe(true);

    // One interval elapses: BOTH the orphaned timer A and the live timer B fire.
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(updateStatus).toHaveBeenCalledTimes(4); // 2 initial + 2 (A + B)

    // A single stop() nulls only the module-level handle (timer B).
    stop();
    expect(_isRunning()).toBe(false);

    // ...but timer A is orphaned and keeps firing: 5 more ticks → 5 more sweeps.
    // (If start() is made idempotent, this should become +0 and total 1.)
    vi.advanceTimersByTime(5 * INTERVAL_MS);
    expect(updateStatus).toHaveBeenCalledTimes(9); // 4 + 5 leaked ticks
  });
});
