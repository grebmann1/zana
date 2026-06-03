// Tests for pure exported helpers in packages/work/src/tickets/watcher.ts.
// parseVerdict, normalizeTrigger, and matchesRule have zero external
// dependencies — no real fs, no real Claude, no real SQLite.
import { describe, it, expect } from "vitest";
import {
  parseVerdict,
  normalizeTrigger,
  matchesRule,
} from "@zana-ai/work/src/tickets/watcher.ts";

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------
describe("parseVerdict", () => {
  it("parses a bare PASS on the last line", () => {
    const r = parseVerdict("Some work done.\nVERDICT: PASS");
    expect(r).toEqual({ kind: "PASS", reason: null });
  });

  it("parses FAIL with an em-dash reason", () => {
    const r = parseVerdict("VERDICT: FAIL — off-by-one in loop");
    expect(r).toEqual({ kind: "FAIL", reason: "off-by-one in loop" });
  });

  it("parses FAIL with an ASCII dash reason", () => {
    const r = parseVerdict("VERDICT: FAIL - missing null check");
    expect(r).toEqual({ kind: "FAIL", reason: "missing null check" });
  });

  it("parses READY and BLOCKED verdicts", () => {
    expect(parseVerdict("VERDICT: READY")?.kind).toBe("READY");
    expect(parseVerdict("VERDICT: BLOCKED — manual review needed")?.kind).toBe("BLOCKED");
  });

  it("is case-insensitive", () => {
    expect(parseVerdict("verdict: pass")?.kind).toBe("PASS");
    expect(parseVerdict("Verdict: Fail — reason")?.kind).toBe("FAIL");
  });

  it("honours the last VERDICT line when there are multiple", () => {
    const text = "VERDICT: FAIL — old\nMore output.\nVERDICT: PASS";
    expect(parseVerdict(text)?.kind).toBe("PASS");
  });

  it("returns null for empty / non-string input", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict(null as any)).toBeNull();
    expect(parseVerdict(42 as any)).toBeNull();
  });

  it("returns null when no VERDICT line is present", () => {
    expect(parseVerdict("All done, no verdict here.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeTrigger
// ---------------------------------------------------------------------------
describe("normalizeTrigger", () => {
  it("passes through a modern trigger unchanged (except defaults)", () => {
    const t = normalizeTrigger({ event: "ticket:created" });
    expect(t.event).toBe("ticket:created");
  });

  it("converts legacy { status } to { event: ticket:statusChanged, to: status }", () => {
    const t = normalizeTrigger({ status: "review" });
    expect(t.event).toBe("ticket:statusChanged");
    expect(t.to).toBe("review");
  });

  it("converts legacy { label } into labels array", () => {
    const t = normalizeTrigger({ label: "urgent" });
    expect(t.labels).toEqual(["urgent"]);
  });

  it("merges legacy label + labels without duplicates", () => {
    const t = normalizeTrigger({ label: "a", labels: ["b", "c"] });
    expect(t.labels).toEqual(["a", "b", "c"]);
  });

  it("defaults event to ticket:statusChanged for modern triggers without event", () => {
    const t = normalizeTrigger({ to: "done" });
    expect(t.event).toBe("ticket:statusChanged");
  });

  it("handles null / non-object gracefully", () => {
    expect(normalizeTrigger(null).event).toBe("ticket:statusChanged");
    expect(normalizeTrigger(undefined).event).toBe("ticket:statusChanged");
  });
});

// ---------------------------------------------------------------------------
// matchesRule
// ---------------------------------------------------------------------------
const ticket = { id: "T-1", status: "review", reviewPhase: "qa", labels: ["bug"] };

describe("matchesRule", () => {
  it("matches when trigger event and status align", () => {
    const rule = {
      trigger: { event: "ticket:statusChanged", to: "review" },
      action: { spawnProfile: "reviewer" },
    };
    expect(matchesRule(rule, "ticket:statusChanged", { newStatus: "review" }, ticket)).toBe(true);
  });

  it("rejects when eventType differs", () => {
    const rule = { trigger: { event: "ticket:created" }, action: { spawnProfile: "x" } };
    expect(matchesRule(rule, "ticket:statusChanged", {}, ticket)).toBe(false);
  });

  it("rejects when 'to' does not match newStatus", () => {
    const rule = { trigger: { event: "ticket:statusChanged", to: "done" }, action: { spawnProfile: "x" } };
    expect(matchesRule(rule, "ticket:statusChanged", { newStatus: "review" }, ticket)).toBe(false);
  });

  it("accepts wildcard '*' in to", () => {
    const rule = { trigger: { event: "ticket:statusChanged", to: "*" }, action: { spawnProfile: "x" } };
    expect(matchesRule(rule, "ticket:statusChanged", { newStatus: "anything" }, ticket)).toBe(true);
  });

  it("matches reviewPhase when specified", () => {
    const ruleMatch = { trigger: { event: "ticket:statusChanged", to: "review", reviewPhase: "qa" }, action: { spawnProfile: "x" } };
    const ruleMiss  = { trigger: { event: "ticket:statusChanged", to: "review", reviewPhase: "arch" }, action: { spawnProfile: "x" } };
    expect(matchesRule(ruleMatch, "ticket:statusChanged", { newStatus: "review" }, ticket)).toBe(true);
    expect(matchesRule(ruleMiss,  "ticket:statusChanged", { newStatus: "review" }, ticket)).toBe(false);
  });

  it("requires all label conditions to be satisfied", () => {
    const rule = { trigger: { event: "ticket:statusChanged", labels: ["bug", "urgent"] }, action: { spawnProfile: "x" } };
    expect(matchesRule(rule, "ticket:statusChanged", {}, ticket)).toBe(false); // ticket has "bug" but not "urgent"

    const ticketBoth = { ...ticket, labels: ["bug", "urgent"] };
    expect(matchesRule(rule, "ticket:statusChanged", {}, ticketBoth)).toBe(true);
  });

  it("never fires when rule.disabled is true", () => {
    const rule = {
      disabled: true,
      trigger: { event: "ticket:statusChanged" },
      action: { spawnProfile: "x" },
    };
    expect(matchesRule(rule, "ticket:statusChanged", {}, ticket)).toBe(false);
  });
});
