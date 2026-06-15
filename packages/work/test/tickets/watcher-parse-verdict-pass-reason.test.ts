// Tests for parseVerdict() reason extraction on a PASS verdict.
//
// Existing suites assert PASS always yields `reason: null` (every PASS fixture
// is bare, e.g. "VERDICT: PASS") and exercise reasons only through FAIL/BLOCKED.
// But the source regex captures the optional reason group for ANY kind:
//   /^VERDICT:\s*(PASS|FAIL|READY|BLOCKED)\b\s*(?:[—–-]\s*(.+))?$/i
// So a PASS that carries a trailing "— reason" must surface that reason too.
// A regression that special-cased PASS to drop its reason would pass every
// existing test — this guards that branch.
//
// Pure function: no fs, no network, no real Claude.
import { describe, it, expect } from "vitest";
import { parseVerdict } from "@zana-ai/work/src/tickets/watcher.ts";

describe("parseVerdict — PASS verdict carrying a reason", () => {
  it("captures the reason after an em-dash on a PASS line", () => {
    const r = parseVerdict("VERDICT: PASS — all checks satisfied");
    expect(r).toEqual({ kind: "PASS", reason: "all checks satisfied" });
  });

  it("still returns reason: null for a bare PASS (no separator)", () => {
    // Baseline guard so the reason path doesn't accidentally fabricate text.
    const r = parseVerdict("VERDICT: PASS");
    expect(r).toEqual({ kind: "PASS", reason: null });
  });
});
