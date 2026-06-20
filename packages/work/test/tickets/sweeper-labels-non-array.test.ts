// Regression test for the `Array.isArray(ticket.labels)` guard in sweeper.ts.
//
// The human-checkpoint exemption checks `ticket.labels.includes("awaiting-decision")`,
// but ONLY after `Array.isArray(ticket.labels)`. Without that guard a ticket whose
// `labels` was persisted as the bare STRING "awaiting-decision" (rather than an
// array) would short-circuit via String.prototype.includes — and any string that
// merely CONTAINS that substring would be falsely treated as human-parked and
// skipped forever. The guard forces such malformed tickets back onto the normal
// staleness path so they still get reconciled.
//
// Existing human-checkpoint tests only exercise array-valued labels; this covers
// the non-array branch of the guard.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@zana-ai/core", () => ({
  modules: { config: { get: () => null } },
  agents: { manager: { listAgents: () => [] } },
  events: { bus: { emit: vi.fn() } },
}));

import {
  sweepOnce,
  stop,
  _setTestSeams,
  _resetTestSeams,
} from "@zana-ai/work/src/tickets/sweeper.ts";

const HOUR = 60 * 60 * 1000;
const FIXED_NOW = Date.parse("2026-06-20T12:00:00.000Z");

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  _resetTestSeams();
  stop();
});

describe("sweepOnce — non-array labels do not satisfy the human gate", () => {
  it("still sweeps a stale blocked ticket whose labels is the bare gate STRING, not an array", () => {
    const staleTs = new Date(FIXED_NOW - 30 * HOUR).toISOString();
    // `labels` is a string that equals the human-gate label. A naive
    // `labels.includes("awaiting-decision")` would return true and wrongly
    // exempt it; the Array.isArray guard must reject it as not-parked.
    const malformed = {
      id: "T-string-labels",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      labels: "awaiting-decision" as any,
      audit: [{ timestamp: staleTs }],
      createdAt: staleTs,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn(() => ({}));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f: { status: string }) =>
        f.status === "blocked" ? [malformed as any] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-string-labels");
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(updateStatus).toHaveBeenCalledWith("T-string-labels", "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", expect.objectContaining({ ticketId: "T-string-labels" }));
  });

  it("sweeps a stale blocked ticket with no labels field at all (undefined)", () => {
    const staleTs = new Date(FIXED_NOW - 30 * HOUR).toISOString();
    const noLabels = {
      id: "T-no-labels",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      // labels intentionally omitted
      audit: [{ timestamp: staleTs }],
      createdAt: staleTs,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn(() => ({}));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f: { status: string }) =>
        f.status === "blocked" ? [noLabels as any] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-no-labels");
    expect(updateStatus).toHaveBeenCalledWith("T-no-labels", "cancelled", "ticket-sweeper");
  });
});
