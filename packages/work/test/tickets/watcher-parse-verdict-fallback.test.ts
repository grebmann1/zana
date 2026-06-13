// Tests for two under-exercised branches of parseVerdict in
// packages/work/src/tickets/watcher.ts.
//
// 1. Fallback path (VERDICT_RE.exec):
//    The primary bottom-up scan stops as soon as it finds a non-blank,
//    non-verdict line at the end of the text. When trailing text follows the
//    verdict (e.g. a closing remark), the loop breaks without a match and
//    VERDICT_RE.exec() is used as a global search to recover the verdict.
//    This behaviour is intentional ("in case the agent appended trailing
//    whitespace or extra punctuation we didn't anticipate") but has no
//    dedicated test.
//
// 2. En-dash (–) separator:
//    The verdict regex uses the character class [—–-] to support em-dash (—),
//    en-dash (–), and ASCII hyphen-minus (-) as separators before the reason.
//    The existing watcher-pure.test.ts covers em-dash and ASCII-dash but never
//    exercises the en-dash branch.

import { describe, it, expect } from "vitest";
import { parseVerdict } from "@zana-ai/work/src/tickets/watcher.ts";

// ---------------------------------------------------------------------------
// Fallback path (VERDICT_RE global search)
// ---------------------------------------------------------------------------

describe("parseVerdict — fallback path (VERDICT_RE) when trailing text follows verdict", () => {
  it("recovers PASS verdict when a non-verdict sentence follows it", () => {
    // Bottom-up loop: last non-blank line = "I hope this helps!" → not a
    // verdict → break.  VERDICT_RE.exec finds "VERDICT: PASS" earlier.
    const text = "Analysis complete.\nVERDICT: PASS\n\nI hope this helps!";
    const r = parseVerdict(text);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("PASS");
    expect(r!.reason).toBeNull();
  });

  it("recovers FAIL verdict with reason when a trailing remark is present", () => {
    const text =
      "Found issues.\nVERDICT: FAIL — missing null check\n\nPlease address before re-review.";
    const r = parseVerdict(text);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("FAIL");
    expect(r!.reason).toBe("missing null check");
  });

  it("returns null when there is no verdict line anywhere in the text", () => {
    const text = "I reviewed the code.\nLooks good to me.\nNo verdict here.";
    expect(parseVerdict(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// En-dash (–, U+2013) separator
// ---------------------------------------------------------------------------

describe("parseVerdict — en-dash (–) separator", () => {
  it("parses FAIL reason separated by en-dash", () => {
    // U+2013 EN DASH — included in [—–-] character class but not yet tested.
    const r = parseVerdict("VERDICT: FAIL – off-by-one error");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("FAIL");
    expect(r!.reason).toBe("off-by-one error");
  });

  it("parses BLOCKED reason separated by en-dash", () => {
    const r = parseVerdict("VERDICT: BLOCKED – awaiting upstream dependency");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("BLOCKED");
    expect(r!.reason).toBe("awaiting upstream dependency");
  });

  it("parses READY with no reason (no en-dash needed)", () => {
    // Verify baseline: READY with no reason returns reason: null.
    const r = parseVerdict("VERDICT: READY");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("READY");
    expect(r!.reason).toBeNull();
  });
});
