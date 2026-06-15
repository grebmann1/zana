// Test for an untested branch of matchesRule in
// packages/work/src/tickets/watcher.ts (line 411):
//
//   if (t.to !== undefined && !matchValue(t.to, payload?.newStatus ?? ticket?.status ?? null)) ...
//
// Every existing `to`-filter test (watcher-match-from, watcher-array-match)
// always supplies `newStatus` in the payload, so the `?? ticket?.status`
// fallback is never exercised. That fallback is what lets a `to` filter work
// for events that carry no newStatus — most notably `ticket:created`, whose
// payload has no status transition. A regression dropping the ticket.status
// fallback would still pass every existing test but silently break `to`
// matching on creation events.
//
// Pure function: no fs, no network, no real Claude.
import { describe, it, expect } from "vitest";
import { matchesRule } from "@zana-ai/work/src/tickets/watcher.ts";

describe("matchesRule — to filter falls back to ticket.status when payload has no newStatus", () => {
  it("matches when ticket.status equals the to value and payload omits newStatus", () => {
    const rule = {
      trigger: { event: "ticket:created", to: "backlog" },
      action: { spawnProfile: "triager" },
    };
    const ticket = { id: "T-1", status: "backlog", reviewPhase: null, labels: [] };
    // payload carries no newStatus (typical for ticket:created) → matchValue
    // must compare against ticket.status.
    expect(matchesRule(rule, "ticket:created", { ticketId: "T-1" }, ticket)).toBe(true);
  });

  it("rejects when ticket.status differs from the to value and payload omits newStatus", () => {
    const rule = {
      trigger: { event: "ticket:created", to: "backlog" },
      action: { spawnProfile: "triager" },
    };
    const ticket = { id: "T-2", status: "in-progress", reviewPhase: null, labels: [] };
    expect(matchesRule(rule, "ticket:created", { ticketId: "T-2" }, ticket)).toBe(false);
  });

  it("prefers payload.newStatus over ticket.status when both are present", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", to: "review" },
      action: { spawnProfile: "reviewer" },
    };
    // ticket.status is stale ("in-progress") but the transition's newStatus is
    // "review" — the payload value must win.
    const ticket = { id: "T-3", status: "in-progress", reviewPhase: null, labels: [] };
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "review" }, ticket),
    ).toBe(true);
  });
});
