// Focused test for the RECURRING interval tick in sweeper.ts start()
// (src lines ~217-223):
//
//   timer = setInterval(() => { try { sweepOnce(); } catch { ... } }, cfg.intervalMs);
//
// The existing suite pins the INITIAL synchronous sweep
// (sweeper-start-initial-sweep.test.ts, which uses a long interval expressly
// "so the only sweep that can run here is the initial one" and advances no
// timers) and the _isRunning() lifecycle toggle (sweeper.test.ts) — but nothing
// proves the periodic timer actually re-runs sweepOnce on each tick, nor that
// stop() halts further ticks. This locks both with deterministic fake timers.
//
// The staleness clock is driven by the `now` seam (FIXED_NOW), independent of
// the fake-timer scheduler, so each tick re-sweeps the same always-stale ticket
// — every sweep that runs calls statusUpdater exactly once, making the
// updateStatus call count a precise sweep counter. No real FS, bus, agents, or
// wall-clock time.

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
    id: "T-recurring",
    status: "blocked",
    assigneeId: null,
    assigneeName: null,
    audit: [{ timestamp: staleAt }],
    createdAt: staleAt,
  };
}

function seamsWith(updateStatus: any) {
  const ticket = alwaysStaleBlockedTicket();
  _setTestSeams({
    now: () => FIXED_NOW,
    agentLister: () => [],
    ticketLister: (f: { status: string }) => (f.status === "blocked" ? [ticket] : []),
    statusUpdater: updateStatus,
    commenter: vi.fn() as any,
    bus: { emit: vi.fn() },
    configReader: () => ({ ticketSweeperIntervalMs: INTERVAL_MS }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  _resetTestSeams();
});

describe("start() — recurring interval tick", () => {
  it("re-runs sweepOnce on each interval tick after the initial sweep", () => {
    const updateStatus = vi.fn(() => ({ ok: true }));
    seamsWith(updateStatus as any);

    start();

    // The initial synchronous sweep ran exactly once inside start().
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(_isRunning()).toBe(true);

    // Each elapsed interval fires one more sweep.
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(updateStatus).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(INTERVAL_MS * 3);
    expect(updateStatus).toHaveBeenCalledTimes(5);
  });

  it("stops sweeping once stop() clears the timer", () => {
    const updateStatus = vi.fn(() => ({ ok: true }));
    seamsWith(updateStatus as any);

    start();
    vi.advanceTimersByTime(INTERVAL_MS); // one recurring tick → 2 sweeps total
    expect(updateStatus).toHaveBeenCalledTimes(2);

    stop();
    expect(_isRunning()).toBe(false);

    // No further ticks fire after stop(), no matter how much time passes.
    vi.advanceTimersByTime(INTERVAL_MS * 10);
    expect(updateStatus).toHaveBeenCalledTimes(2);
  });
});
