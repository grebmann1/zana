// Focused error-resilience tests for packages/work/src/tickets/sweeper.ts.
//
// Covers the three exception / error-result branches that are absent from
// sweeper.test.ts:
//   1. statusUpdater returns { error: "..." } — ticket must be skipped, no
//      comment must be added, and no bus event must be emitted.
//   2. agentLister throws — alive set must become empty so the sweep still
//      proceeds (treating all assignees as dead) rather than aborting.
//   3. ticketLister throws — that status bucket is treated as empty, but
//      other buckets are still swept normally.

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

function staleTicket(status: string, assigneeId = "agent-dead") {
  const now = Date.parse("2026-06-05T12:00:00.000Z");
  return {
    id: "T-" + Math.random().toString(36).slice(2),
    status,
    assigneeId,
    assigneeName: "dead-agent",
    audit: [{ timestamp: new Date(now - 25 * HOUR).toISOString() }],
    createdAt: new Date(now - 25 * HOUR).toISOString(),
  };
}

const FIXED_NOW = Date.parse("2026-06-05T12:00:00.000Z");

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

// ── 1. statusUpdater returns an error ──────────────────────────────────────

describe("sweepOnce — statusUpdater returns error", () => {
  it("increments skipped, does NOT call commenter or emit bus event", () => {
    const t = staleTicket("in-progress");
    const updateStatus = vi.fn(() => ({ error: "db locked" }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "in-progress" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    // The ticket must not appear in `swept`
    expect(result.swept).toHaveLength(0);
    // It was attempted (statusUpdater called once) but failed, so counted as skipped
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(addComment).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThan(0);
  });
});

// ── 2. agentLister throws ─────────────────────────────────────────────────

describe("sweepOnce — agentLister throws", () => {
  it("treats all assignees as dead and sweeps stale tickets normally", () => {
    const t = staleTicket("in-progress");
    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => { throw new Error("daemon not ready"); },
      ticketLister: (f) => (f.status === "in-progress" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    // Must not throw at the call site
    const result = sweepOnce();

    // With an empty alive set the stale in-progress ticket should be swept
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-assignee-dead");
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", expect.objectContaining({ ticketId: t.id }));
  });
});

// ── 3. ticketLister throws for one status ────────────────────────────────

describe("sweepOnce — ticketLister throws for one status bucket", () => {
  it("treats the failing bucket as empty and still sweeps other statuses", () => {
    const blocked = staleTicket("blocked", null as any);
    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => {
        if (f.status === "in-progress") throw new Error("db error");
        if (f.status === "blocked") return [blocked];
        return [];
      },
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    // Must not throw even when one status bucket throws
    const result = sweepOnce();

    // The blocked ticket (time-only rule, no assignee needed) must be swept
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(updateStatus).toHaveBeenCalledWith(blocked.id, "cancelled", "ticket-sweeper");
  });
});
