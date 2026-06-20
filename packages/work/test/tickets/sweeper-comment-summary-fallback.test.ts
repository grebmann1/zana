// Focused test for the auto-cancel comment summary in
// packages/work/src/tickets/sweeper.ts.
//
// Existing sweeper tests assert the comment body merely *contains* "stale" /
// "Auto-cancelled" / "re-open". They never exercise the `assigneeName || "none"`
// fallback (sweeper.ts line ~174) nor the exact `hoursStale` rounding that is
// interpolated into that same summary. A `blocked` ticket with a null
// `assigneeName` is realistic — the sweeper time-rule fires for it regardless of
// assignee — so the summary must read "assignee none not alive." and the stale
// hour count must match the rounded age.

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

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

describe("sweepOnce — comment summary assigneeName fallback", () => {
  it("renders 'assignee none not alive' and the rounded stale hours when assigneeName is null", () => {
    // 26h stale → past the 24h default threshold; blocked → time-only rule.
    const staleTs = new Date(FIXED_NOW - 26 * HOUR).toISOString();
    const ticket = {
      id: "T-no-assignee",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [{ timestamp: staleTs }],
      createdAt: staleTs,
    };

    const updateStatus = vi.fn(() => ({ ok: true }));
    const addComment = vi.fn(() => ({}));
    const busEmit = vi.fn();

    _setTestSeams({
      now: () => FIXED_NOW,
      agentLister: () => [],
      ticketLister: (f) => (f.status === "blocked" ? [ticket] : []),
      statusUpdater: updateStatus as any,
      commenter: addComment as any,
      bus: { emit: busEmit },
    });

    const result = sweepOnce();

    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].reason).toBe("stale-no-activity");
    // Math.round(26h / 3_600_000ms) === 26
    expect(result.swept[0].hoursStale).toBe(26);

    // The summary body must use the "none" fallback and the rounded hour count.
    const body = addComment.mock.calls[0][3] as string;
    expect(body).toContain("assignee none not alive.");
    expect(body).toContain("stale for 26h");
  });
});
