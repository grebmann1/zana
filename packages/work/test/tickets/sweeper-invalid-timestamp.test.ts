// Tests for the `isNaN(ms) ? 0 : ms` guard inside `lastActivityMs` in
// packages/work/src/tickets/sweeper.ts (lines 110-117).
//
// When a ticket has no audit entries AND a missing or corrupt `createdAt`,
// Date.parse() returns NaN and the guard substitutes epoch (0).  That makes
// ageMs = now - 0 ≈ decades, which always exceeds the stale threshold, so
// the ticket is swept even though its "real" age is unknown.  This is the
// intended defensive behavior (unknown ≙ "safe to close").
//
// Previously untested — confirmed by grep:
//   grep -rn "isNaN\|invalid.*date\|bad.*timestamp" test/tickets/sweeper*.test.ts
// returned zero results.

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

const FIXED_NOW = Date.parse("2026-06-09T12:00:00.000Z");

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

// ── corrupt / missing createdAt → epoch fallback ──────────────────────────

describe("sweepOnce — lastActivityMs epoch fallback on invalid timestamp", () => {
  it("sweeps a blocked ticket whose createdAt is an invalid date string", () => {
    // Date.parse("not-a-date") === NaN → lastActivityMs returns 0
    // → ageMs = FIXED_NOW - 0 >> threshold → ticket is swept.
    const t = {
      id: "T-corrupt-date",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [],
      createdAt: "not-a-date",
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
    expect(result.swept[0].ticket.id).toBe("T-corrupt-date");
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(updateStatus).toHaveBeenCalledWith("T-corrupt-date", "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: "T-corrupt-date" }),
    );
  });

  it("sweeps a blocked ticket whose createdAt is null (Date.parse(null) → NaN)", () => {
    const t = {
      id: "T-null-date",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [],
      createdAt: null as any,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "blocked" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: vi.fn() },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-null-date");
    expect(updateStatus).toHaveBeenCalledWith("T-null-date", "cancelled", "ticket-sweeper");
  });

  it("sweeps a stale in-progress ticket with dead assignee and corrupt createdAt", () => {
    // Confirms the same epoch fallback works for non-blocked eligible statuses.
    const t = {
      id: "T-dead-corrupt",
      status: "in-progress",
      assigneeId: "ghost-agent",
      assigneeName: "ghost",
      audit: [],
      createdAt: "garbage",
    };

    const updateStatus = vi.fn(() => ({ ok: true }));

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],  // ghost-agent not alive
      ticketLister: (f) => (f.status === "in-progress" ? [t] : []),
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: vi.fn() },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-assignee-dead");
    expect(updateStatus).toHaveBeenCalledWith("T-dead-corrupt", "cancelled", "ticket-sweeper");
  });
});
