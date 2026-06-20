// Focused test for the `lastAudit?.timestamp || ticket.createdAt` precedence in
// `lastActivityMs` (sweeper.ts, ~line 119) — the TRUTHY-but-unparseable branch.
//
// Coverage gap: sweeper-last-audit-missing-timestamp covers only the FALSY
// last-audit timestamp (missing / empty string), where `|| createdAt` takes
// over. sweeper-invalid-timestamp covers only an EMPTY audit array with a
// corrupt createdAt. Neither exercises the distinct case where the last audit
// entry carries a NON-EMPTY but unparseable timestamp (e.g. "garbage"): being
// truthy, it SHADOWS createdAt, so `iso` is the corrupt string regardless of
// how recent createdAt is. Date.parse() then returns NaN → the `isNaN(ms) ? 0`
// guard substitutes epoch (0) → ageMs ≈ decades → the ticket is swept even
// though it was created seconds ago.
//
// This pins a subtle, slightly dangerous precedence: a corrupt last-audit
// timestamp can cause a FRESH ticket to be auto-cancelled. A refactor that
// flipped the precedence (anchoring on createdAt when the audit timestamp is
// unparseable) would change this behavior, and no current test would catch it.
//
// All I/O is mocked via the documented seams — deterministic clock, no FS, no
// real bus, no real agents.

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

describe("sweepOnce — lastActivityMs: a corrupt last-audit timestamp shadows a recent createdAt", () => {
  it("SWEEPS a freshly-created blocked ticket because the unparseable last-audit timestamp shadows createdAt", () => {
    // createdAt is 1 minute ago — far inside the 24 h threshold — but the LAST
    // audit entry has a non-empty, unparseable timestamp. Because that string
    // is truthy, `lastAudit?.timestamp || createdAt` resolves to the garbage
    // string, NOT the recent createdAt. Date.parse("garbage") === NaN → 0 →
    // ageMs ≈ decades → swept, despite the ticket being seconds old.
    const recentCreatedAt = new Date(FIXED_NOW - 1 * 60 * 1000).toISOString();
    const t = {
      id: "T-corrupt-last-audit",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [
        { timestamp: new Date(FIXED_NOW - 2 * HOUR).toISOString() },
        { timestamp: "garbage-not-a-date" }, // truthy but unparseable → shadows createdAt
      ],
      createdAt: recentCreatedAt,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn();
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f: { status: string }) =>
        f.status === "blocked" ? [t as any] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    // The corrupt timestamp wins over the recent createdAt → treated as ancient.
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-corrupt-last-audit");
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(updateStatus).toHaveBeenCalledWith(
      "T-corrupt-last-audit",
      "cancelled",
      "ticket-sweeper",
    );
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: "T-corrupt-last-audit", reason: "stale-no-activity" }),
    );
  });
});
