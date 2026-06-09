// Focused test for the `lastActivityMs` createdAt fallback in sweeper.ts.
//
// The `lastActivityMs(ticket)` helper (lines 110-117 of sweeper.ts) returns
// the timestamp of the LAST audit entry when the audit array is non-empty,
// and falls back to `ticket.createdAt` when audit is empty (or absent).
//
// Every existing sweeper test that actually triggers a sweep passes an
// `audit: [{ timestamp: stale }]` override, so the createdAt fallback
// path has never been exercised by the test suite.

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
const FIXED_NOW = Date.parse("2026-06-09T12:00:00.000Z");

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

describe("sweepOnce — lastActivityMs createdAt fallback (empty audit array)", () => {
  it("sweeps a stale blocked ticket when audit is empty and createdAt is past the threshold", () => {
    // audit: [] → lastActivityMs must use createdAt as the staleness anchor.
    // createdAt is 25 h ago which exceeds the default 24 h threshold.
    const staleAt = new Date(FIXED_NOW - 25 * HOUR).toISOString();
    const t = {
      id: "T-empty-audit-stale",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [],              // ← triggers the createdAt fallback in lastActivityMs
      createdAt: staleAt,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "blocked" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: t.id, reason: "stale-no-activity" }),
    );
  });

  it("preserves a blocked ticket when audit is empty and createdAt is within the threshold", () => {
    // audit: [] → lastActivityMs falls back to createdAt (1 h ago — well within 24 h).
    const recentAt = new Date(FIXED_NOW - 1 * HOUR).toISOString();
    const t = {
      id: "T-empty-audit-recent",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [],
      createdAt: recentAt,
    };

    const updateStatus = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "blocked" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });

  it("sweeps a stale in-progress ticket with empty audit and dead assignee using createdAt", () => {
    // Covers the same lastActivityMs fallback for non-blocked eligible statuses.
    const staleAt = new Date(FIXED_NOW - 25 * HOUR).toISOString();
    const t = {
      id: "T-empty-audit-inprogress",
      status: "in-progress",
      assigneeId: "agent-dead",
      assigneeName: "dead-agent",
      audit: [],
      createdAt: staleAt,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],   // assignee is dead
      ticketLister: (f) => (f.status === "in-progress" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-assignee-dead");
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: t.id }),
    );
  });
});
