// Focused test for sweepOnce() aggregating across MULTIPLE eligible status
// buckets in a single pass.
//
// Every other sweeper test exercises one ELIGIBLE_STATUSES bucket per run.
// None pins the cross-bucket accounting: that the outer loop visits each
// status, accumulates `total` across buckets, sweeps the eligible ones with
// the correct per-status `reason`, and counts the rest as `skipped` — all in
// one sweepOnce() call.

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

function ticket(id: string, status: string, opts: { ageHours?: number; assigneeId?: string | null } = {}) {
  const ageHours = opts.ageHours ?? 25;
  const ts = new Date(FIXED_NOW - ageHours * HOUR).toISOString();
  return {
    id,
    status,
    assigneeId: opts.assigneeId === undefined ? "agent-dead" : opts.assigneeId,
    assigneeName: "dead-agent",
    audit: [{ timestamp: ts }],
    createdAt: ts,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

describe("sweepOnce — aggregates across multiple status buckets in one pass", () => {
  it("sweeps eligible tickets from different buckets, tallies total/skipped, and tags each reason", () => {
    // blocked  → swept on time alone (reason stale-no-activity)
    const blocked = ticket("T-blocked", "blocked");
    // in-progress, dead assignee → swept (reason stale-assignee-dead)
    const inProgressDead = ticket("T-inprog", "in-progress");
    // review, live assignee → counted but NOT swept (skipped)
    const reviewLive = ticket("T-review", "review", { assigneeId: "agent-live" });
    // rework, recent activity → counted but NOT swept (skipped, within threshold)
    const reworkFresh = ticket("T-rework", "rework", { ageHours: 1 });

    const byStatus: Record<string, any[]> = {
      "in-progress": [inProgressDead],
      review: [reviewLive],
      rework: [reworkFresh],
      blocked: [blocked],
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [{ id: "agent-live", state: "active" }], // only T-review's assignee is alive
      ticketLister: (f) => byStatus[f.status] ?? [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    // Two swept (blocked + dead in-progress), two skipped (live review + fresh rework).
    expect(result.total).toBe(4);
    expect(result.skipped).toBe(2);
    expect(result.swept).toHaveLength(2);

    const sweptById = Object.fromEntries(result.swept.map((d) => [d.ticket.id, d.reason]));
    expect(sweptById).toEqual({
      "T-blocked": "stale-no-activity",
      "T-inprog": "stale-assignee-dead",
    });

    // Only the swept tickets trigger cancellation + comment + event.
    expect(updateStatus).toHaveBeenCalledTimes(2);
    expect(updateStatus).toHaveBeenCalledWith("T-blocked", "cancelled", "ticket-sweeper");
    expect(updateStatus).toHaveBeenCalledWith("T-inprog", "cancelled", "ticket-sweeper");
    expect(updateStatus).not.toHaveBeenCalledWith("T-review", expect.anything(), expect.anything());
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(busEmit).toHaveBeenCalledTimes(2);
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", { ticketId: "T-blocked", reason: "stale-no-activity" });
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", { ticketId: "T-inprog", reason: "stale-assignee-dead" });
  });
});
