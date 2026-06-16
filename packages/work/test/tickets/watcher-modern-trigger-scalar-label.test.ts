// Tests the modern-trigger scalar-`label` branch of normalizeTrigger in
// packages/work/src/tickets/watcher.ts (line ~396):
//
//   labels: Array.isArray(t.labels) ? t.labels
//           : (typeof t.label === "string" ? [t.label] : undefined)
//
// Existing coverage (watcher-pure.test.ts) only exercises the LEGACY branch,
// where a bare `{ label }` (no `event`) is rewritten to ticket:statusChanged.
// When an `event` IS present, normalizeTrigger takes the modern branch instead,
// and the scalar `label` → `labels[]` coercion there is currently untested —
// as is its end-to-end effect on matchesRule's label filtering.
//
// Pure helpers: no real fs, no real Claude, no real SQLite, no bus.
import { describe, it, expect } from "vitest";
import { normalizeTrigger, matchesRule } from "@zana-ai/work/src/tickets/watcher.ts";

describe("normalizeTrigger — modern trigger with scalar label", () => {
  it("coerces a scalar `label` into a labels[] array when `event` is present", () => {
    const t = normalizeTrigger({ event: "ticket:statusChanged", to: "review", label: "urgent" });
    expect(t.event).toBe("ticket:statusChanged");
    expect(t.to).toBe("review");
    expect(t.labels).toEqual(["urgent"]);
  });

  it("prefers an explicit labels[] over scalar label in the modern branch", () => {
    const t = normalizeTrigger({ event: "ticket:created", labels: ["bug", "p0"], label: "ignored" });
    expect(t.labels).toEqual(["bug", "p0"]);
  });
});

describe("matchesRule — modern trigger scalar label filters end-to-end", () => {
  const baseRule = {
    trigger: { event: "ticket:statusChanged", to: "review", label: "urgent" },
    action: { spawnProfile: "reviewer" },
  };

  it("matches when the ticket carries the required label", () => {
    const ticket = { id: "T-1", status: "review", reviewPhase: "qa", labels: ["urgent", "bug"] };
    expect(matchesRule(baseRule, "ticket:statusChanged", { newStatus: "review" }, ticket)).toBe(true);
  });

  it("rejects when the ticket is missing the required label", () => {
    const ticket = { id: "T-2", status: "review", reviewPhase: "qa", labels: ["bug"] };
    expect(matchesRule(baseRule, "ticket:statusChanged", { newStatus: "review" }, ticket)).toBe(false);
  });
});
