// Focused test for the `blocked` sweep path in sweeper.ts.
//
// The code (lines 159-168 of sweeper.ts) intentionally skips the
// assignee-alive check for `blocked` tickets — staleness alone is
// sufficient to sweep them regardless of whether the assignee is live.
// This is deliberate: a blocked ticket is waiting on a human/external
// dependency, so the live/dead agent distinction is irrelevant.
//
// No existing test exercises a blocked ticket whose assigneeId appears
// in the alive agent registry. This file covers that omitted branch.

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
const FIXED_NOW = Date.parse("2026-06-09T12:00:00.000Z");

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  _resetTestSeams();
  stop();
});

describe("sweepOnce — blocked ticket with a live assignee", () => {
  it("sweeps a stale blocked ticket even when the assignee agent is still alive", () => {
    // The assignee is alive — for `in-progress`/`review`/`rework` this would
    // cause a skip, but for `blocked` the code bypasses the alive check entirely.
    const staleTs = new Date(FIXED_NOW - 25 * HOUR).toISOString();
    const ticket = {
      id: "T-blocked-live",
      status: "blocked",
      assigneeId: "agent-still-alive",
      assigneeName: "live-agent",
      audit: [{ timestamp: staleTs }],
      createdAt: staleTs,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn(() => ({}));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      // The alive set contains the assignee — an `in-progress` ticket with this
      // assignee would be skipped, but `blocked` must still be swept.
      agentLister: () => [{ id: "agent-still-alive", state: "running" }],
      ticketLister: (f: { status: string }) =>
        f.status === "blocked" ? [ticket] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    // The blocked ticket must be swept even though the assignee is alive.
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-blocked-live");
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(result.skipped).toBe(0);

    // Downstream calls must be made.
    expect(updateStatus).toHaveBeenCalledWith("T-blocked-live", "cancelled", "ticket-sweeper");
    expect(addComment).toHaveBeenCalledWith(
      "T-blocked-live",
      "ticket-sweeper",
      "ticket-sweeper",
      expect.stringContaining("stale"),
    );
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", {
      ticketId: "T-blocked-live",
      reason: "stale-no-activity",
    });
  });
});
