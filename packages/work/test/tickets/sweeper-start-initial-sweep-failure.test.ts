// Focused resilience test for sweeper.ts start() when the INITIAL sweep throws.
//
// start() (sweeper.ts:214-216) deliberately wraps its immediate, synchronous
// sweep in try/catch: a backlog-clearing sweep that explodes (e.g. a clock or
// dependency hiccup the moment the daemon comes up) must NOT prevent the
// recurring interval timer from being armed. Otherwise a single transient
// failure at boot would silently disable the sweeper for the whole process
// lifetime.
//
// The existing start() suites only ever exercise a CLEAN initial sweep
// (sweeper-start-initial-sweep pins the success path; sweeper-interval-recurring
// pins the interval-tick catch on line 218). Nothing pins the line-214 catch.
// This test forces the initial sweepOnce() to throw — by injecting a now()
// seam that throws, which escapes sweepOnce's internal guards (getConfig and
// the alive-set/per-ticket try/catches all run before now() is read at line
// 151) — and asserts start() swallows it, still arms the timer (_isRunning()
// === true), and returns a working disposer.
//
// All I/O is mocked via the documented test seams — no FS, no real bus, no real
// agents, deterministic (no real clock, no random).

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

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  _resetTestSeams();
  stop();
});

describe("start() — initial sweep failure resilience", () => {
  it("swallows a throwing initial sweep and still arms the recurring timer", () => {
    const updateStatus = vi.fn(() => ({ ok: true }));
    const busEmit = vi.fn();

    _setTestSeams({
      // now() is read inside sweepOnce (line 151), AFTER getConfig succeeds and
      // outside its internal try/catch blocks — so throwing here makes the
      // initial sweepOnce() throw without start()'s own getConfig (line 211)
      // failing first.
      now: () => {
        throw new Error("clock unavailable at boot");
      },
      agentLister: () => [],
      ticketLister: () => [],
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
      // Enabled, positive interval → start() must proceed to arm the timer.
      configReader: () => ({ ticketSweeperIntervalMs: 60 * 60 * 1000 }),
    });

    // start() must NOT propagate the initial-sweep failure.
    let stopFn: (() => void) | undefined;
    expect(() => {
      stopFn = start();
    }).not.toThrow();

    // The recurring timer is armed despite the failed initial sweep.
    expect(_isRunning()).toBe(true);
    // No ticket work happened (the sweep blew up before touching anything).
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();

    // The returned disposer is a real, working stop() — tears the timer down.
    expect(typeof stopFn).toBe("function");
    stopFn!();
    expect(_isRunning()).toBe(false);
  });
});
