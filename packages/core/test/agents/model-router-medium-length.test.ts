// Focused coverage for the OPUS-keyword path at MEDIUM prompt lengths.
//
// In model-router.ts the OPUS-keyword check (line 23) carries NO length gate:
// it fires for any prompt containing an Opus keyword, regardless of size. The
// length fast path only catches len > 2000, and the HAIKU branch only fires for
// len < 200 — so the 200..2000 mid-range is governed solely by keyword/category
// rules. Every existing OPUS-keyword test uses a SHORT (<200 char) prompt, so a
// regression that wrongly gated the Opus keyword on length (e.g. `len < 200`,
// mirroring the Haiku branch) would pass the entire current suite while
// silently downgrading a substantial design/security task to SONNET. These
// cases pin the mid-range so that can't slip through.

import { describe, it, expect } from "vitest";
import { selectModel, TIERS } from "@zana-ai/core/src/agents/model-router.ts";

describe("model-router — OPUS keyword at medium prompt lengths", () => {
  it("routes a 200..2000-char prompt with an OPUS keyword to OPUS", () => {
    const prompt = "please design this module " + "a".repeat(500);
    expect(prompt.length).toBeGreaterThanOrEqual(200);
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(selectModel(prompt)).toBe(TIERS.OPUS);
  });

  it("OPUS keyword wins over a HAIKU keyword in the mid-length range", () => {
    // "list" (haiku) + "security" (opus) in a >=200-char prompt: the HAIKU gate
    // (len < 200) cannot fire, and the Opus keyword has no length gate → OPUS.
    const prompt = "list and review the security posture " + "a".repeat(300);
    expect(prompt.length).toBeGreaterThanOrEqual(200);
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(selectModel(prompt)).toBe(TIERS.OPUS);
  });

  it("OPUS keyword wins over a SONNET category hint in the mid-length range", () => {
    const prompt = "architect the new pipeline " + "a".repeat(400);
    expect(prompt.length).toBeGreaterThanOrEqual(200);
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(selectModel(prompt, { category: "code-review" })).toBe(TIERS.OPUS);
  });

  // The mirror of the OPUS-keyword cases above: a mid-length prompt whose ONLY
  // keyword is a HAIKU one (no Opus keyword, no category) must fall through to
  // the SONNET default. The HAIKU branch is gated on `len < 200` (line 24), so
  // at >=200 chars it cannot fire, and nothing else matches. The existing suite
  // only asserts such a prompt is `not.toBe(HAIKU)` — it never pins the exact
  // tier, so a regression that loosened the HAIKU gate to `len < 2000` (routing
  // it to the cheapest tier) OR one that mis-routed it to OPUS would both slip
  // through. This pins the precise SONNET landing for the mid-range HAIKU case.
  it("routes a 200..2000-char HAIKU-keyword-only prompt to SONNET, not HAIKU or OPUS", () => {
    const prompt = "list the open tasks " + "a".repeat(400);
    expect(prompt.length).toBeGreaterThanOrEqual(200);
    expect(prompt.length).toBeLessThanOrEqual(2000);
    const result = selectModel(prompt);
    expect(result).toBe(TIERS.SONNET);
    expect(result).not.toBe(TIERS.HAIKU);
    expect(result).not.toBe(TIERS.OPUS);
  });
});
