// Tests for two untested code paths in packages/work/src/tickets/watcher.ts:
//
//   1. normalizeTrigger — modern trigger (has `event`) with a bare `label` key:
//      line 391 converts it to `labels: [label]`, but existing tests only
//      exercise the legacy path (no `event` key).
//
//   2. matchesRule / matchValue — array `to` spec:
//      line 398 handles Array.isArray(spec) but no test exercises the multi-
//      value form `to: ["review", "done"]`.
//
// Both helpers are pure functions with no external I/O.

import { describe, it, expect } from "vitest";
import {
  normalizeTrigger,
  matchesRule,
} from "@zana-ai/work/src/tickets/watcher.ts";

const baseTicket = { id: "T-42", status: "review", reviewPhase: "qa", labels: [] };

// ---------------------------------------------------------------------------
// normalizeTrigger — modern trigger + bare `label` key
// ---------------------------------------------------------------------------
describe("normalizeTrigger — modern trigger with bare label", () => {
  it("converts a bare string label into a labels array on a modern trigger", () => {
    // Modern trigger: has an explicit `event` key. The legacy branch is skipped.
    // Line 391: `(typeof t.label === "string" ? [t.label] : undefined)` must fire.
    const t = normalizeTrigger({ event: "ticket:created", label: "needs-review" });
    expect(t.event).toBe("ticket:created");
    expect(t.labels).toEqual(["needs-review"]);
  });

  it("prefers explicit labels array over bare label on a modern trigger", () => {
    // When both labels (array) and label (string) are present on a modern
    // trigger, the array wins because Array.isArray(t.labels) is true.
    const t = normalizeTrigger({ event: "ticket:statusChanged", label: "extra", labels: ["a", "b"] });
    expect(t.labels).toEqual(["a", "b"]);
    // The bare `label` key must NOT be appended — the legacy merge path is not
    // taken here (the modern branch only does one of the two alternatives).
    expect(t.labels).not.toContain("extra");
  });

  it("sets labels to undefined when modern trigger has no label / labels", () => {
    const t = normalizeTrigger({ event: "ticket:created" });
    expect(t.labels).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// matchesRule — array `to` spec (matchValue array branch)
// ---------------------------------------------------------------------------
describe("matchesRule — array `to` spec", () => {
  it("matches when newStatus is one value in the to array", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", to: ["review", "done"] },
      action: { spawnProfile: "reviewer" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "review" }, baseTicket),
    ).toBe(true);
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "done" }, baseTicket),
    ).toBe(true);
  });

  it("rejects when newStatus is not in the to array", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", to: ["review", "done"] },
      action: { spawnProfile: "reviewer" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "backlog" }, baseTicket),
    ).toBe(false);
  });

  it("matches when the to array contains the wildcard '*'", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", to: ["review", "*"] },
      action: { spawnProfile: "any" },
    };
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "anything-at-all" }, baseTicket),
    ).toBe(true);
  });
});
