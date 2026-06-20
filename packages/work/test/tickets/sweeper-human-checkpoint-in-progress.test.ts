// Regression test for the human-checkpoint exemption on a NON-blocked ticket.
//
// The `awaiting-decision` exemption in sweeper.ts (src line ~168) sits BEFORE
// the assignee-dead branch (src line ~178) and is status-agnostic. The existing
// exemption tests (sweeper-human-checkpoint-skip) only exercise `blocked`
// tickets, where the assignee-dead check never runs — so they would still pass
// even if the label check were moved below the assignee-dead branch. That
// reordering would silently start sweeping parked `in-progress` checkpoints.
//
// This test pins the exemption on an otherwise-sweepable in-progress ticket
// (stale + dead assignee). The contrasting case (same ticket, no label) proves
// the label is the sole reason it is preserved.
//
// All I/O is mocked via the documented test seams — deterministic clock, no FS,
// no real bus, no real agents.

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

function staleInProgress(labels: string[]) {
  const staleTs = new Date(FIXED_NOW - 30 * HOUR).toISOString();
  return {
    id: "T-inprogress-parked",
    status: "in-progress",
    assigneeId: "agent-dead", // not in the (empty) alive set → assignee is dead
    assigneeName: "dead-agent",
    labels,
    audit: [{ timestamp: staleTs }],
    createdAt: staleTs,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  _resetTestSeams();
  stop();
});

describe("sweepOnce — human-checkpoint exemption protects in-progress tickets", () => {
  it("does NOT sweep a stale in-progress ticket with a dead assignee when parked on a human", () => {
    const parked = staleInProgress(["awaiting-decision"]);
    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn(() => ({}));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [], // empty → assignee-dead would otherwise trigger a sweep
      ticketLister: (f: { status: string }) =>
        f.status === "in-progress" ? [parked] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalledWith("ticket:swept", expect.anything());
  });

  it("DOES sweep the same stale in-progress dead-assignee ticket once the human-gate label is removed", () => {
    const abandoned = staleInProgress(["needs-triage"]); // some other label
    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn(() => ({}));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f: { status: string }) =>
        f.status === "in-progress" ? [abandoned] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-inprogress-parked");
    expect(result.swept[0].reason).toBe("stale-assignee-dead");
    expect(updateStatus).toHaveBeenCalledWith("T-inprogress-parked", "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: "T-inprogress-parked" }),
    );
  });
});
