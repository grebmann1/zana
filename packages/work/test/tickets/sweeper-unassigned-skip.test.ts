// Focused test for the `!ticket.assigneeId` guard in sweepOnce().
//
// sweeper.ts (line ~163):
//   if (!ticket.assigneeId || alive.has(ticket.assigneeId)) {
//     skipped++;
//     continue;
//   }
//
// A stale `in-progress` / `review` / `rework` ticket with NO assigneeId
// must be SKIPPED — the sweeper is designed to clean up tickets whose
// assignee agent has died; an unassigned ticket has no dead agent to
// attribute, so sweeping it would be incorrect.
//
// None of the existing sweeper test files exercise this path:
//  - sweeper.test.ts uses assigneeId="agent-zombie" for the in-progress cases
//  - sweeper-review-rework.test.ts always passes an assigneeId
//  - sweeper-createdAt-fallback.test.ts uses null assigneeId only for *blocked* tickets

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
const FIXED_NOW = Date.parse("2026-06-12T10:00:00.000Z");

/** Build a stale ticket with no assigneeId for the given status. */
function unassignedStaleTicket(status: string, id: string) {
  return {
    id,
    status,
    assigneeId: null,
    assigneeName: null,
    audit: [{ timestamp: new Date(FIXED_NOW - 25 * HOUR).toISOString() }],
    createdAt: new Date(FIXED_NOW - 25 * HOUR).toISOString(),
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

describe("sweepOnce — unassigned (assigneeId=null) stale tickets are never swept", () => {
  it("skips a stale in-progress ticket with no assigneeId", () => {
    const t = unassignedStaleTicket("in-progress", "T-unassigned-ip");
    const updateStatus = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [], // alive set is empty — no living agents
      ticketLister: (f) => (f.status === "in-progress" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    // Must NOT be swept — no assigneeId means no dead agent to attribute.
    expect(result.swept).toHaveLength(0);
    // Must be counted as skipped, not ignored silently.
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });

  it("skips a stale review ticket with no assigneeId", () => {
    const t = unassignedStaleTicket("review", "T-unassigned-review");
    const updateStatus = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "review" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });

  it("skips a stale rework ticket with no assigneeId", () => {
    const t = unassignedStaleTicket("rework", "T-unassigned-rework");
    const updateStatus = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "rework" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });

  it("total count still reflects unassigned stale tickets (they are counted, just not swept)", () => {
    // Verifies the `total` counter includes the ticket even though it is skipped.
    const t = unassignedStaleTicket("in-progress", "T-unassigned-total");
    const updateStatus = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "in-progress" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: vi.fn() },
    });

    const result = sweepOnce();

    // The ticket was seen (total ≥ 1) but not swept.
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.swept).toHaveLength(0);
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
