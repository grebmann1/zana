// Regression test for the human-checkpoint sweep exemption in sweeper.ts.
//
// A ticket parked on a human checkpoint carries the `awaiting-decision` label.
// recoverStuckTicket forces crashed tickets to `blocked` AND raises that
// checkpoint, so they look exactly like a stale blocked ticket to the sweeper.
// Before the fix the sweeper cancelled any stale `blocked` ticket regardless
// of label — silently killing every crash-recovered ticket that was waiting on
// a human 24h later, defeating the checkpoint (ADR 0011 §4).
//
// The sweeper must skip tickets carrying `awaiting-decision` and let the human
// resolve them.

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

describe("sweepOnce — human-checkpoint exemption", () => {
  it("does NOT cancel a stale blocked ticket parked on a human checkpoint", () => {
    const staleTs = new Date(FIXED_NOW - 30 * HOUR).toISOString();
    const parked = {
      id: "T-awaiting-human",
      status: "blocked",
      labels: ["awaiting-decision"],
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
        f.status === "blocked" ? [parked] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    // Parked-on-human ticket must be skipped, not swept.
    expect(result.swept).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalledWith("ticket:swept", expect.anything());
  });

  it("still sweeps a stale blocked ticket that is NOT parked on a human", () => {
    const staleTs = new Date(FIXED_NOW - 30 * HOUR).toISOString();
    const abandoned = {
      id: "T-truly-stale",
      status: "blocked",
      labels: ["needs-triage"], // some other label — not the human gate
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
        f.status === "blocked" ? [abandoned] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-truly-stale");
    expect(updateStatus).toHaveBeenCalledWith("T-truly-stale", "cancelled", "ticket-sweeper");
  });
});
