// Focused test for the null-agent-entry guard in packages/work/src/tickets/sweeper.ts.
//
// sweepOnce builds its "alive" set with:
//   agentLister().filter((a) => a && a.state !== "terminated").map((a) => a.id)
// The leading `a &&` guard tolerates a null/undefined element inside the agent
// list (e.g. a partially-populated or concurrently-mutated registry). The
// existing suites pass `[]`, fully-populated arrays, or make agentLister throw,
// but none exercise a list that CONTAINS a null entry. This test pins that the
// guard (1) does not throw and (2) still derives a correct alive set from the
// surviving entries — so a stale ticket owned by a live agent is kept while one
// owned by a dead agent is swept.

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

describe("sweepOnce — null entry in the agent list", () => {
  it("ignores the null entry, keeps the live assignee's ticket, sweeps the dead one", () => {
    const ownedByLive = staleTicket("in-progress", "agent-live");
    const ownedByDead = staleTicket("in-progress", "agent-dead");
    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      // A null and an undefined element sit alongside one live agent.
      agentLister: () =>
        [null, undefined, { id: "agent-live", state: "running" }] as any,
      ticketLister: (f) =>
        f.status === "in-progress" ? [ownedByLive, ownedByDead] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    // The guard must keep the filter from throwing on the null/undefined items.
    const result = sweepOnce();

    // Only the dead-assignee ticket is swept; the live one survives, proving the
    // alive set was built correctly despite the null entries.
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe(ownedByDead.id);
    expect(result.swept[0].reason).toBe("stale-assignee-dead");
    expect(updateStatus).toHaveBeenCalledWith(
      ownedByDead.id,
      "cancelled",
      "ticket-sweeper",
    );
    expect(updateStatus).not.toHaveBeenCalledWith(
      ownedByLive.id,
      "cancelled",
      "ticket-sweeper",
    );
  });
});
