// Focused test for the staleness anchor in sweeper.ts `lastActivityMs`.
//
// `lastActivityMs(ticket)` (sweeper.ts lines 111-118) reads the timestamp of
// the LAST audit entry — `audit[audit.length - 1]` — so staleness is measured
// from the MOST RECENT activity, not from ticket creation/claim.
//
// Every existing sweeper test that exercises a non-empty audit passes a
// single-element array (`audit: [{ timestamp: ... }]`), where first === last.
// That leaves the "last, not first" semantics unpinned: a regression to
// `audit[0]` would wrongly anchor staleness to the OLDEST entry and still pass
// the whole suite. These tests use multi-entry audit trails whose first and
// last timestamps straddle the threshold, so the two implementations diverge.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@zana-ai/core", () => ({
  modules: { config: { get: () => null } },
  agents: { manager: { listAgents: () => [] } },
  events: { bus: { emit: vi.fn() } },
}));

import {
  sweepOnce,
  _setTestSeams,
  _resetTestSeams,
} from "@zana-ai/work/src/tickets/sweeper.ts";

const HOUR = 60 * 60 * 1000;
const FIXED_NOW = Date.parse("2026-06-09T12:00:00.000Z");

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

describe("sweepOnce — staleness anchored to the LAST audit entry", () => {
  it("preserves a blocked ticket whose FIRST audit entry is stale but LAST is recent", () => {
    // First entry 30 h ago (stale), last entry 1 h ago (fresh). Anchoring on
    // the last entry → within threshold → NOT swept. An `audit[0]` regression
    // would read 30 h, exceed the 24 h threshold, and wrongly sweep it.
    const t = {
      id: "T-recent-activity",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [
        { timestamp: new Date(FIXED_NOW - 30 * HOUR).toISOString() },
        { timestamp: new Date(FIXED_NOW - 5 * HOUR).toISOString() },
        { timestamp: new Date(FIXED_NOW - 1 * HOUR).toISOString() },
      ],
      createdAt: new Date(FIXED_NOW - 30 * HOUR).toISOString(),
    };

    const updateStatus = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "blocked" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });

  it("sweeps a blocked ticket whose FIRST audit entry is recent but LAST is stale", () => {
    // First entry 1 h ago, last entry 25 h ago. Anchoring on the last entry →
    // past threshold → swept. An `audit[0]` regression would read 1 h and
    // wrongly preserve it. The hoursStale figure also pins the last entry.
    const t = {
      id: "T-no-recent-activity",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [
        { timestamp: new Date(FIXED_NOW - 1 * HOUR).toISOString() },
        { timestamp: new Date(FIXED_NOW - 25 * HOUR).toISOString() },
      ],
      createdAt: new Date(FIXED_NOW - 26 * HOUR).toISOString(),
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "blocked" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(result.swept[0].hoursStale).toBe(25);
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: t.id, reason: "stale-no-activity" }),
    );
  });
});
