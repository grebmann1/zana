// Focused test for the `lastAudit?.timestamp || ticket.createdAt` fallback in
// `lastActivityMs` (sweeper.ts, ~line 119).
//
// Coverage gap: every existing non-empty-audit test (sweeper-last-audit-entry,
// sweeper-createdAt-fallback) supplies a VALID `timestamp` on the last audit
// entry, and the createdAt-fallback case only ever uses an EMPTY audit array
// (the `lastAudit === null` path). The distinct branch where the audit array is
// NON-EMPTY but the last entry's `timestamp` is falsy (missing / empty string)
// — so `lastAudit?.timestamp` is falsy and the `|| ticket.createdAt` clause
// takes over — is never exercised. A regression dropping that `|| createdAt`
// fallback (e.g. anchoring on `lastAudit?.timestamp` alone) would make `iso`
// undefined → Date.parse(undefined) === NaN → epoch (0) → ALWAYS swept,
// silently cancelling fresh tickets whose latest audit entry happens to lack a
// timestamp. No current test would catch that.
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

describe("sweepOnce — lastActivityMs falls back to createdAt when the last audit entry has no timestamp", () => {
  it("PRESERVES a blocked ticket whose last audit entry lacks a timestamp but createdAt is recent", () => {
    // Non-empty audit, but the LAST entry has no `timestamp` field, so
    // `lastAudit?.timestamp` is undefined → the `|| createdAt` clause anchors
    // staleness on createdAt (1 h ago — well within the 24 h threshold).
    // A regression that anchored on `lastAudit?.timestamp` alone would parse
    // undefined → NaN → epoch (0) → wrongly sweep this fresh ticket.
    const recentCreatedAt = new Date(FIXED_NOW - 1 * HOUR).toISOString();
    const t = {
      id: "T-missing-ts-recent",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [
        { timestamp: new Date(FIXED_NOW - 2 * HOUR).toISOString() },
        {} as any, // last entry: no timestamp → falsy → fall back to createdAt
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

    expect(result.swept).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalledWith("ticket:swept", expect.anything());
  });

  it("SWEEPS a blocked ticket whose last audit entry lacks a timestamp and createdAt is stale", () => {
    // Same fallback, opposite side of the threshold: createdAt is 30 h ago, so
    // anchoring on createdAt exceeds the 24 h threshold → swept as stale.
    const staleCreatedAt = new Date(FIXED_NOW - 30 * HOUR).toISOString();
    const t = {
      id: "T-missing-ts-stale",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [
        { timestamp: new Date(FIXED_NOW - 40 * HOUR).toISOString() },
        { timestamp: "" }, // last entry: empty-string timestamp → falsy fallback
      ],
      createdAt: staleCreatedAt,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f: { status: string }) =>
        f.status === "blocked" ? [t as any] : [],
      statusUpdater: updateStatus as any,
      commenter: vi.fn() as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-missing-ts-stale");
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(updateStatus).toHaveBeenCalledWith("T-missing-ts-stale", "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: "T-missing-ts-stale", reason: "stale-no-activity" }),
    );
  });
});
