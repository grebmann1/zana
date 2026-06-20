// Focused test for the terminated-state half of the alive-set predicate in
// packages/work/src/tickets/sweeper.ts.
//
// sweepOnce builds its "alive" set with:
//   agentLister().filter((a) => a && a.state !== "terminated").map((a) => a.id)
// The existing suites cover the `a &&` half (null/undefined entries) and the
// "agent missing from the list entirely" case, but none exercise an assignee
// whose agent IS present in the registry yet sits in state "terminated". That
// agent must be EXCLUDED from the alive set, so a stale in-progress ticket it
// owns is swept as "stale-assignee-dead" — while a sibling owned by a non-
// terminated agent in the same list is preserved. This pins the predicate so a
// regression to e.g. `a.state === "running"` (which would wrongly drop other
// live states) or dropping the terminated check (which would wrongly keep dead
// agents alive) is caught.

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
const FIXED_NOW = Date.parse("2026-06-05T12:00:00.000Z");

function staleTicket(status: string, assigneeId: string | null) {
  return {
    id: "T-" + assigneeId,
    status,
    assigneeId,
    assigneeName: assigneeId,
    audit: [{ timestamp: new Date(FIXED_NOW - 25 * HOUR).toISOString() }],
    createdAt: new Date(FIXED_NOW - 25 * HOUR).toISOString(),
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

describe("sweepOnce — assignee agent present but in state 'terminated'", () => {
  it("treats a terminated assignee as dead and sweeps its stale ticket, keeping the non-terminated sibling", () => {
    const ownedByTerminated = staleTicket("in-progress", "agent-terminated");
    const ownedByActive = staleTicket("in-progress", "agent-active");
    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      // Both assignees are LISTED. One is terminated (→ dead), one is active.
      agentLister: () =>
        [
          { id: "agent-terminated", state: "terminated" },
          { id: "agent-active", state: "active" },
        ] as any,
      ticketLister: (f) =>
        f.status === "in-progress"
          ? [ownedByTerminated, ownedByActive]
          : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    // Only the terminated-assignee ticket is swept; the active one survives.
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe(ownedByTerminated.id);
    expect(result.swept[0].reason).toBe("stale-assignee-dead");
    expect(updateStatus).toHaveBeenCalledWith(
      ownedByTerminated.id,
      "cancelled",
      "ticket-sweeper",
    );
    expect(updateStatus).not.toHaveBeenCalledWith(
      ownedByActive.id,
      "cancelled",
      "ticket-sweeper",
    );
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", {
      ticketId: ownedByTerminated.id,
      reason: "stale-assignee-dead",
    });
  });
});
