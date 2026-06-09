// Focused tests for sweepOnce() against the `review` and `rework` statuses.
//
// Both statuses are present in ELIGIBLE_STATUSES and must follow the same
// "stale + dead assignee → sweep" path as `in-progress`.  They were absent
// from the existing sweeper.test.ts / sweeper-errors.test.ts coverage.

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
const FIXED_NOW = Date.parse("2026-06-06T12:00:00.000Z");

function staleTicket(status: string, assigneeId = "agent-dead") {
  return {
    id: "T-" + Math.random().toString(36).slice(2),
    status,
    assigneeId,
    assigneeName: "dead-agent",
    audit: [{ timestamp: new Date(FIXED_NOW - 25 * HOUR).toISOString() }],
    createdAt: new Date(FIXED_NOW - 25 * HOUR).toISOString(),
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

describe("sweepOnce — review status", () => {
  it("sweeps a stale review ticket whose assignee is dead", () => {
    const t = staleTicket("review");
    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],                         // empty alive set → assignee is dead
      ticketLister: (f) => (f.status === "review" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-assignee-dead");
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", { ticketId: t.id, reason: "stale-assignee-dead" });
  });

  it("preserves a review ticket whose assignee is still alive", () => {
    const t = staleTicket("review", "agent-live");
    const updateStatus = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [{ id: "agent-live", state: "active" }],
      ticketLister: (f) => (f.status === "review" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });
});

describe("sweepOnce — rework status", () => {
  it("sweeps a stale rework ticket whose assignee is dead", () => {
    const t = staleTicket("rework");
    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "rework" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-assignee-dead");
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", { ticketId: t.id, reason: "stale-assignee-dead" });
  });

  it("preserves a rework ticket that still has a live assignee", () => {
    const t = staleTicket("rework", "agent-live");
    const updateStatus = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [{ id: "agent-live", state: "active" }],
      ticketLister: (f) => (f.status === "rework" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });
});
