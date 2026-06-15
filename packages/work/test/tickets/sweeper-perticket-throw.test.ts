// Focused resilience test for the PER-TICKET inner catch in
// packages/work/src/tickets/sweeper.ts (the `try { ... } catch (err)` around
// each ticket inside the status loop, lines ~154-188).
//
// Gap this closes: sweeper-errors.test.ts exercises agentLister throwing and
// ticketLister throwing (both OUTSIDE the per-ticket try), plus statusUpdater
// RETURNING { error }. None of them make a mutation seam THROW while a ticket
// is being processed. That inner catch guards an important invariant: a single
// corrupt ticket or a transient exception from statusUpdater/commenter/bus must
// NOT abort the whole sweep — the offending ticket is counted as skipped and
// the loop continues to reconcile the remaining stale tickets.
//
// Deterministic: injected clock + fakes, no real timers, network, or Claude.

import { describe, it, expect, vi, afterEach } from "vitest";

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

function staleInProgress(id: string) {
  const stamp = new Date(FIXED_NOW - 25 * HOUR).toISOString();
  return {
    id,
    status: "in-progress",
    assigneeId: "agent-dead",
    assigneeName: "dead-agent",
    audit: [{ timestamp: stamp }],
    createdAt: stamp,
  };
}

afterEach(() => _resetTestSeams());

describe("sweepOnce — a mutation seam throws while processing one ticket", () => {
  it("skips the throwing ticket and still sweeps the rest of the bucket", () => {
    const boom = staleInProgress("T-boom");
    const ok = staleInProgress("T-ok");

    // statusUpdater throws (rather than returning {error}) for the first
    // ticket only — the second must still be swept normally.
    const statusUpdater = vi.fn((id: string) => {
      if (id === "T-boom") throw new Error("transient db explosion");
      return { ok: true };
    });
    const commenter = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [], // empty alive set → assignee treated as dead
      ticketLister: (f) =>
        f.status === "in-progress" ? [boom, ok] : [],
      statusUpdater: statusUpdater as any,
      commenter: commenter as any,
      bus: { emit: busEmit },
    });

    // The thrown error must be swallowed by the per-ticket catch.
    const result = sweepOnce();

    // Only the healthy ticket is swept; the throwing one is dropped.
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-ok");
    expect(result.swept[0].reason).toBe("stale-assignee-dead");

    // The throwing ticket was attempted then counted as skipped.
    expect(statusUpdater).toHaveBeenCalledWith("T-boom", "cancelled", "ticket-sweeper");
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.total).toBe(2);

    // Side effects fired only for the ticket that succeeded.
    expect(commenter).toHaveBeenCalledTimes(1);
    expect(commenter.mock.calls[0][0]).toBe("T-ok");
    expect(busEmit).toHaveBeenCalledTimes(1);
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: "T-ok" }),
    );
  });
});
