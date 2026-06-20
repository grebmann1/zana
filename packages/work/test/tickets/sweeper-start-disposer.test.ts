// Focused test for the disposer returned by sweeper.ts start() (src line ~223):
//
//   export function start(): () => void { ...; return stop; }
//
// Every enabled-path lifecycle test (sweeper.test.ts, sweeper-interval-recurring.ts)
// halts the timer by calling the MODULE-LEVEL stop() directly. Nothing exercises
// the function start() hands back. So if start() were changed to `return () => {}`
// on the enabled path, the whole suite would stay green while the documented
// disposer contract silently broke — callers that hold only the returned handle
// (the intended ownership model, mirroring zombie-reaper) could never stop the
// sweep.
//
// This pins that the returned disposer truly stops the recurring timer: after
// calling it, _isRunning() is false and no further interval ticks sweep. The
// staleness clock is the FIXED_NOW seam (independent of the fake-timer
// scheduler), so updateStatus is a precise per-sweep counter. No real FS, bus,
// agents, or wall-clock time.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@zana-ai/core", () => ({
  modules: { config: { get: () => null } },
  agents: { manager: { listAgents: () => [] } },
  events: { bus: { emit: vi.fn() } },
}));

import {
  start,
  stop,
  _setTestSeams,
  _resetTestSeams,
  _isRunning,
} from "@zana-ai/work/src/tickets/sweeper.ts";

const HOUR = 60 * 60 * 1000;
const FIXED_NOW = Date.parse("2026-06-09T10:00:00.000Z");
const INTERVAL_MS = 1000;

function alwaysStaleBlockedTicket() {
  // 30h stale, blocked → swept on time alone (no assignee check needed).
  const staleAt = new Date(FIXED_NOW - 30 * HOUR).toISOString();
  return {
    id: "T-disposer",
    status: "blocked",
    assigneeId: null,
    assigneeName: null,
    audit: [{ timestamp: staleAt }],
    createdAt: staleAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  stop(); // safety net in case an assertion fails before the disposer runs
  vi.useRealTimers();
  _resetTestSeams();
});

describe("start() — returned disposer", () => {
  it("halts the recurring sweep when called (without touching module-level stop())", () => {
    const updateStatus = vi.fn(() => ({ ok: true }));
    const ticket = alwaysStaleBlockedTicket();
    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f: { status: string }) => (f.status === "blocked" ? [ticket] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: vi.fn() },
      configReader: () => ({ ticketSweeperIntervalMs: INTERVAL_MS }),
    });

    const dispose = start();

    // Initial synchronous sweep ran once inside start(); timer is live.
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(_isRunning()).toBe(true);

    // One recurring tick fires before disposal → 2 sweeps total.
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(updateStatus).toHaveBeenCalledTimes(2);

    // Call the handle start() returned — NOT the module-level stop().
    expect(() => dispose()).not.toThrow();
    expect(_isRunning()).toBe(false);

    // No further ticks fire, no matter how much time passes.
    vi.advanceTimersByTime(INTERVAL_MS * 10);
    expect(updateStatus).toHaveBeenCalledTimes(2);
  });
});
