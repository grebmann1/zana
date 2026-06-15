// Focused boundary test for the staleness comparison in sweeper.ts.
//
//   src line 156:  if (ageMs <= cfg.staleThresholdMs) { skipped++; continue; }
//
// The `<=` makes the threshold INCLUSIVE: a ticket whose age is exactly equal
// to the stale threshold is treated as "not yet stale" and preserved. Only a
// ticket strictly OLDER than the threshold is swept.
//
// The existing suite pins "within" (25h vs 48h → kept) and "exceeds"
// (49h vs 48h → swept) but never the exact equality point. This file pins both
// sides of the boundary by one millisecond, so a refactor that flips `<=` to
// `<` (an off-by-one that would start sweeping tickets a hair too early) fails
// loudly here.
//
// All I/O is mocked via the documented test seams — deterministic clock, no FS,
// no real bus, no real agents. Uses `blocked` status so the sweep decision
// depends purely on age (the blocked path needs no assignee-dead check).

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
const FIXED_NOW = Date.parse("2026-06-09T10:00:00.000Z");
const THRESHOLD = 24 * HOUR; // default ticketStaleThresholdMs

function blockedTicketLastActiveAt(isoOffsetMs: number) {
  const ts = new Date(FIXED_NOW - isoOffsetMs).toISOString();
  return {
    id: "T-boundary",
    status: "blocked",
    assigneeId: null,
    assigneeName: null,
    audit: [{ timestamp: ts }],
    createdAt: ts,
  };
}

function seamsFor(ticket: any, updateStatus: any, busEmit: any) {
  _setTestSeams({
    now: () => FIXED_NOW,
    agentLister: () => [],
    ticketLister: (f: { status: string }) => (f.status === "blocked" ? [ticket] : []),
    statusUpdater: updateStatus,
    commenter: vi.fn() as any,
    bus: { emit: busEmit },
    // No configReader override → default 24h threshold.
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  _resetTestSeams();
  stop();
});

describe("sweepOnce — stale threshold is inclusive (boundary)", () => {
  it("does NOT sweep a ticket whose age is exactly the stale threshold", () => {
    // ageMs === THRESHOLD → `ageMs <= THRESHOLD` is true → skipped (preserved).
    const t = blockedTicketLastActiveAt(THRESHOLD);
    const updateStatus = vi.fn(() => ({ ok: true }));
    const busEmit = vi.fn();
    seamsFor(t, updateStatus as any, busEmit);

    const result = sweepOnce();

    expect(result.swept).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.total).toBe(1);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(busEmit).not.toHaveBeenCalled();
  });

  it("sweeps a ticket that is one millisecond past the stale threshold", () => {
    // ageMs === THRESHOLD + 1 → strictly greater → swept. Pins the boundary at
    // exactly THRESHOLD: the smallest age that triggers a sweep.
    const t = blockedTicketLastActiveAt(THRESHOLD + 1);
    const updateStatus = vi.fn(() => ({ ok: true }));
    const busEmit = vi.fn();
    seamsFor(t, updateStatus as any, busEmit);

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(updateStatus).toHaveBeenCalledWith(t.id, "cancelled", "ticket-sweeper");
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      expect.objectContaining({ ticketId: t.id }),
    );
  });
});
