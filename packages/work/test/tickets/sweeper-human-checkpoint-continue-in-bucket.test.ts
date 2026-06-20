// Regression test: the human-gate (`awaiting-decision`) exemption must `continue`
// past a parked ticket, NOT abort the status bucket.
//
// In sweeper.ts the label exemption (src line ~168) does `skipped++; continue;`.
// Every existing exemption test (sweeper-human-checkpoint-skip /
// -in-progress) places the parked ticket ALONE in its bucket, and the
// multi-bucket test puts at most one ticket per status. None pins that a
// parked ticket sitting BEFORE an otherwise-sweepable ticket in the SAME
// bucket does not stop the loop. If the `continue` were ever refactored into a
// `break`/`return`, the trailing sweepable ticket would be silently skipped and
// all current tests would still pass — this test closes that hole.
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

function staleBlocked(id: string, labels: string[]) {
  const staleTs = new Date(FIXED_NOW - 30 * HOUR).toISOString();
  return {
    id,
    status: "blocked",
    assigneeId: null,
    assigneeName: null,
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

describe("sweepOnce — human-gate skip continues within the same bucket", () => {
  it("skips the parked ticket but still sweeps a later sweepable ticket in the same bucket", () => {
    // Parked ticket FIRST, sweepable ticket SECOND — order matters: a `break`
    // refactor would drop the second one.
    const parked = staleBlocked("T-parked", ["awaiting-decision"]);
    const sweepable = staleBlocked("T-sweepable", ["needs-triage"]);

    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn(() => ({}));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f: { status: string }) =>
        f.status === "blocked" ? [parked, sweepable] : [],
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    // Both tickets visited; one parked (skipped), one swept.
    expect(result.total).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-sweepable");
    expect(result.swept[0].reason).toBe("stale-no-activity");

    // The parked ticket is never touched; the trailing one is fully processed.
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith("T-sweepable", "cancelled", "ticket-sweeper");
    expect(updateStatus).not.toHaveBeenCalledWith("T-parked", expect.anything(), expect.anything());
    expect(busEmit).toHaveBeenCalledTimes(1);
    expect(busEmit).toHaveBeenCalledWith("ticket:swept", { ticketId: "T-sweepable", reason: "stale-no-activity" });
  });
});
