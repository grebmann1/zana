// Tests for the LEGACY trigger normalization branch in watcher.ts
// (src lines ~375-385): a bare `{ status, reviewPhase }` trigger — no `event`
// key — is rewritten to a modern `ticket:statusChanged` trigger with `status`
// mapped onto `to` while `reviewPhase` is carried through. Existing suites
// cover legacy `{ status }` alone, legacy `{ label }` alone, and the MODERN
// `reviewPhase` path, but never the legacy status+reviewPhase combination,
// which flows through a separate code path from the modern branch.
// Pure helpers: no fs, no network, no real Claude.
import { describe, it, expect } from "vitest";
import {
  normalizeTrigger,
  matchesRule,
} from "@zana-ai/work/src/tickets/watcher.ts";

describe("normalizeTrigger — legacy { status, reviewPhase } combination", () => {
  it("maps status→to, carries reviewPhase, and defaults event to ticket:statusChanged", () => {
    const t = normalizeTrigger({ status: "review", reviewPhase: "qa" });
    expect(t.event).toBe("ticket:statusChanged");
    expect(t.to).toBe("review");
    expect(t.reviewPhase).toBe("qa");
    expect(t.labels).toBeUndefined();
  });
});

describe("matchesRule — legacy status+reviewPhase trigger conjunction", () => {
  const ticket = { id: "T-1", status: "review", reviewPhase: "qa", labels: [] };
  const rule = {
    trigger: { status: "review", reviewPhase: "qa" },
    action: { spawnProfile: "reviewer" },
  };

  it("matches when both the new status and the ticket reviewPhase align", () => {
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "review" }, ticket),
    ).toBe(true);
  });

  it("rejects when the reviewPhase differs even though status matches", () => {
    const otherPhase = { ...ticket, reviewPhase: "architecture" };
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "review" }, otherPhase),
    ).toBe(false);
  });

  it("rejects when the status differs even though reviewPhase matches", () => {
    expect(
      matchesRule(rule, "ticket:statusChanged", { newStatus: "done" }, ticket),
    ).toBe(false);
  });
});
