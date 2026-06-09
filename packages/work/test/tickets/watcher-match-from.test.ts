// Tests for the `from` (oldStatus) filter in matchesRule and the array-spec
// variant of the `to` filter.  Both code paths live in
// packages/work/src/tickets/watcher.ts but were completely absent from
// every existing test file — confirmed by a repo-wide grep for `from.*oldStatus`.

import { describe, it, expect } from "vitest";
import { matchesRule } from "@zana-ai/work/src/tickets/watcher.ts";

const ticket = { id: "T-1", status: "review", reviewPhase: "qa", labels: [] };

// ── from filter ──────────────────────────────────────────────────────────────

describe("matchesRule — from (oldStatus) filter", () => {
  it("matches when from equals payload.oldStatus", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", from: "in-progress" },
      action: { spawnProfile: "reviewer" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { oldStatus: "in-progress", newStatus: "review" }, ticket),
    ).toBe(true);
  });

  it("rejects when from does not match payload.oldStatus", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", from: "backlog" },
      action: { spawnProfile: "reviewer" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { oldStatus: "in-progress", newStatus: "review" }, ticket),
    ).toBe(false);
  });

  it("wildcard '*' in from matches any oldStatus value", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", from: "*" },
      action: { spawnProfile: "reviewer" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { oldStatus: "anything" }, ticket),
    ).toBe(true);
  });

  it("matches when from is an array that includes the oldStatus value", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", from: ["in-progress", "rework"] },
      action: { spawnProfile: "reviewer" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { oldStatus: "rework", newStatus: "review" }, ticket),
    ).toBe(true);
  });

  it("rejects when from is an array and oldStatus is not in the list", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", from: ["backlog", "in-progress"] },
      action: { spawnProfile: "reviewer" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { oldStatus: "review" }, ticket),
    ).toBe(false);
  });

  it("passes (does not filter) when from is undefined", () => {
    // No `from` in trigger → oldStatus is irrelevant, should still match on event+to.
    const rule = {
      trigger: { event: "ticket:statusChanged" },
      action: { spawnProfile: "reviewer" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { oldStatus: "backlog", newStatus: "in-progress" }, ticket),
    ).toBe(true);
  });

  it("treats missing payload.oldStatus as null — matches when from is null", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", from: null },
      action: { spawnProfile: "reviewer" },
    };
    // from===null → matchValue returns true (pass-through), so the rule still matches.
    expect(
      matchesRule(rule, "ticket:statusChanged", {}, ticket),
    ).toBe(true);
  });
});

// ── to filter — array variant ────────────────────────────────────────────────

describe("matchesRule — to filter with array spec", () => {
  it("matches when newStatus is any element of the to array", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", to: ["review", "done"] },
      action: { spawnProfile: "notifier" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "done" }, ticket),
    ).toBe(true);
  });

  it("rejects when newStatus is NOT in the to array", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", to: ["review", "done"] },
      action: { spawnProfile: "notifier" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "blocked" }, ticket),
    ).toBe(false);
  });

  it("wildcard '*' inside a to array matches any newStatus", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", to: ["cancelled", "*"] },
      action: { spawnProfile: "notifier" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "anything" }, ticket),
    ).toBe(true);
  });
});
