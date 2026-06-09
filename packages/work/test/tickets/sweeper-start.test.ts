// Focused tests for sweeper.ts start() early-exit paths and getConfig()
// custom-value reading.
//
// Covers three branches absent from sweeper.test.ts / sweeper-errors.test.ts:
//   1. start() returns no-op and leaves _isRunning() === false when
//      ticketSweeperEnabled is false in the config.
//   2. start() returns no-op when ticketSweeperIntervalMs <= 0.
//   3. getConfig() propagates custom staleThresholdMs so tickets just
//      inside a longer threshold are NOT swept.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@zana-ai/core", () => ({
  modules: { config: { get: () => null } },
  agents: { manager: { listAgents: () => [] } },
  events: { bus: { emit: vi.fn() } },
}));

import {
  sweepOnce,
  start,
  stop,
  _setTestSeams,
  _resetTestSeams,
  _isRunning,
} from "@zana-ai/work/src/tickets/sweeper.ts";

const HOUR = 60 * 60 * 1000;
const FIXED_NOW = Date.parse("2026-06-09T10:00:00.000Z");

function noopSeams(overrides: Record<string, any> = {}) {
  _setTestSeams({
    now: () => FIXED_NOW,
    agentLister: () => [],
    ticketLister: () => [],
    statusUpdater: vi.fn(() => ({ ok: true })) as any,
    commenter: vi.fn() as any,
    bus: { emit: vi.fn() },
    ...overrides,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  _resetTestSeams();
  stop();
});

// ── 1. start() is a no-op when ticketSweeperEnabled is false ─────────────────

describe("start() — disabled via config", () => {
  it("returns a no-op and _isRunning() stays false", () => {
    noopSeams({ configReader: () => ({ ticketSweeperEnabled: false }) });

    const stopFn = start();

    expect(_isRunning()).toBe(false);
    // The returned value must be callable without error (it is a no-op fn)
    expect(() => stopFn()).not.toThrow();
    expect(_isRunning()).toBe(false);
  });
});

// ── 2. start() is a no-op when intervalMs is 0 ───────────────────────────────

describe("start() — zero intervalMs", () => {
  it("returns a no-op and _isRunning() stays false", () => {
    noopSeams({ configReader: () => ({ ticketSweeperIntervalMs: 0 }) });

    const stopFn = start();

    expect(_isRunning()).toBe(false);
    expect(() => stopFn()).not.toThrow();
  });
});

// ── 3. getConfig() custom staleThresholdMs — longer threshold skips tickets ──

describe("sweepOnce() — custom staleThresholdMs from config", () => {
  it("does not sweep a ticket that is within a longer custom threshold", () => {
    // Default threshold is 24 h.  We extend it to 48 h; a ticket that is
    // 25 h stale (swept under the default) must be preserved here.
    const staleAt = new Date(FIXED_NOW - 25 * HOUR).toISOString();
    const t = {
      id: "T-custom-threshold",
      status: "in-progress",
      assigneeId: "agent-dead",
      assigneeName: "dead-agent",
      audit: [{ timestamp: staleAt }],
      createdAt: staleAt,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],   // assignee is dead
      ticketLister: (f: { status: string }) => (f.status === "in-progress" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
      // 48 h threshold — 25 h stale ticket is inside the window
      configReader: () => ({ ticketStaleThresholdMs: 48 * HOUR }),
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });

  it("sweeps a ticket that exceeds a custom threshold", () => {
    // 49 h stale against a 48 h threshold → must be swept
    const staleAt = new Date(FIXED_NOW - 49 * HOUR).toISOString();
    const t = {
      id: "T-over-custom-threshold",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [{ timestamp: staleAt }],
      createdAt: staleAt,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f: { status: string }) => (f.status === "blocked" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
      configReader: () => ({ ticketStaleThresholdMs: 48 * HOUR }),
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", expect.objectContaining({ ticketId: t.id }));
  });
});
