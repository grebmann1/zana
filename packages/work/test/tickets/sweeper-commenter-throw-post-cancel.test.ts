// Focused test for the PER-TICKET inner catch in
// packages/work/src/tickets/sweeper.ts — specifically the ordering where the
// `commenter` seam throws AFTER `statusUpdater` has already succeeded.
//
// Gap this closes: sweeper-perticket-throw.test.ts makes `statusUpdater` itself
// throw, so the cancel never lands and nothing downstream runs. sweeper-errors
// covers `statusUpdater` RETURNING { error }. Neither exercises the realistic
// partial-failure window in sweepOnce(): the status update succeeds (the ticket
// IS cancelled in the store), and only then does `commenter` throw — between the
// successful cancel (line ~189) and the `bus.emit("ticket:swept")` /
// `swept.push()` that follow it (lines ~197-198).
//
// The invariant: that thrown error is swallowed by the per-ticket catch, so the
// already-cancelled ticket is counted as `skipped` rather than `swept`, NO
// `ticket:swept` event is emitted for it (the emit is downstream of the throw),
// and the rest of the bucket is still reconciled normally. This documents that a
// comment failure cannot resurrect a swept-event for a ticket nor abort the loop.
//
// Deterministic: injected clock + fakes, no real timers, network, FS, or Claude.

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

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

describe("sweepOnce — commenter throws after a successful status update", () => {
  it("counts the already-cancelled ticket as skipped, emits no swept event for it, and keeps reconciling the bucket", () => {
    const boom = staleInProgress("T-comment-boom");
    const ok = staleInProgress("T-ok");

    // The cancel succeeds for every ticket — the ticket IS marked cancelled.
    const statusUpdater = vi.fn(() => ({ ok: true }));
    // But the comment write throws for the first ticket only, AFTER its cancel.
    const commenter = vi.fn((id: string) => {
      if (id === "T-comment-boom") throw new Error("comment store offline");
      return {};
    });
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [], // empty alive set → assignee treated as dead
      ticketLister: (f) => (f.status === "in-progress" ? [boom, ok] : []),
      statusUpdater: statusUpdater as any,
      commenter: commenter as any,
      bus: { emit: busEmit },
    });

    // The thrown comment error must be swallowed by the per-ticket catch.
    const result = sweepOnce();

    // Both tickets were cancelled in the store...
    expect(statusUpdater).toHaveBeenCalledWith("T-comment-boom", "cancelled", "ticket-sweeper");
    expect(statusUpdater).toHaveBeenCalledWith("T-ok", "cancelled", "ticket-sweeper");

    // ...but only the healthy one is reported as swept; the comment-throwing
    // ticket falls into the catch and is counted as skipped instead.
    expect(result.total).toBe(2);
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-ok");
    expect(result.skipped).toBe(1);

    // No `ticket:swept` event may fire for the throwing ticket — the emit is
    // downstream of the comment call, so it is never reached.
    expect(busEmit).toHaveBeenCalledTimes(1);
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: "T-ok" }),
    );
    expect(busEmit).not.toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: "T-comment-boom" }),
    );
  });
});
