// Focused test for the statusUpdater success guard in
// packages/work/src/tickets/sweeper.ts (line ~190):
//
//   const updateRes = statusUpdater(...);
//   if (updateRes && updateRes.error) { ...skip... }
//
// Existing sweeper tests only feed the updater either a truthy `{ ok: true }`
// (success) or an explicit `{ error: "..." }` (failure). Neither pins the
// FALSY-result branch: a `statusUpdater` that returns `undefined`/`null` (no
// error object) must be treated as a SUCCESSFUL cancel — the sweeper then
// comments, emits `ticket:swept`, and records the decision. This locks that
// resilience behavior so a future "require a truthy result" change is caught.

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
const FIXED_NOW = Date.parse("2026-06-10T12:00:00.000Z");

beforeEach(() => vi.clearAllMocks());
afterEach(() => _resetTestSeams());

describe("sweepOnce — statusUpdater returns a falsy result", () => {
  it("treats an undefined updater result as success (comments, emits, records swept)", () => {
    // 30h stale, blocked → time-only rule fires regardless of assignee.
    const staleTs = new Date(FIXED_NOW - 30 * HOUR).toISOString();
    const ticket = {
      id: "T-falsy-update",
      status: "blocked",
      assigneeId: null,
      assigneeName: null,
      audit: [{ timestamp: staleTs }],
      createdAt: staleTs,
    };

    // Updater returns undefined — no `{ error }`, but also not a truthy ok.
    const updateStatus = vi.fn(() => undefined);
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

    // The falsy result must NOT short-circuit the error path.
    expect(updateStatus).toHaveBeenCalledWith("T-falsy-update", "cancelled", "ticket-sweeper");
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].ticket.id).toBe("T-falsy-update");
    expect(result.swept[0].reason).toBe("stale-no-activity");
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(busEmit).toHaveBeenCalledWith(
      "ticket:swept",
      { ticketId: "T-falsy-update", reason: "stale-no-activity" },
    );
  });
});
