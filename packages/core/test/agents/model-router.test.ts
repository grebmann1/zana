import { describe, it, expect } from "vitest";
import { selectModel, TIERS } from "@zana-ai/core/src/agents/model-router.ts";

describe("model-router — selectModel", () => {
  // ── explicit user override ──────────────────────────────────────────────
  it("returns the explicit model from profileHints regardless of prompt", () => {
    expect(selectModel("design a secure architecture", { model: "my-custom-model" }))
      .toBe("my-custom-model");
  });

  // ── length-based fast path ──────────────────────────────────────────────
  it("returns OPUS for prompts longer than 2000 characters", () => {
    const longPrompt = "x".repeat(2001);
    expect(selectModel(longPrompt)).toBe(TIERS.OPUS);
  });

  it("does not trigger the length fast path for exactly 2000 characters", () => {
    const borderPrompt = "x".repeat(2000);
    // No Opus/Haiku keyword — should fall through to default SONNET
    expect(selectModel(borderPrompt)).toBe(TIERS.SONNET);
  });

  // ── precedence: length fast path wins over a Haiku keyword ──────────────
  // The `len > 2000` check (model-router.ts line 20) runs BEFORE the short-
  // prompt Haiku-keyword check (line 24), and the Haiku branch additionally
  // gates on `len < 200`. A long prompt that merely contains a Haiku keyword
  // (e.g. "list ...") must therefore route to OPUS, never be downgraded to
  // the cheapest tier. Pins the cost/correctness invariant that a large task
  // is not misrouted to Haiku — currently untested.
  it("routes a >2000-char prompt to OPUS even when it contains a HAIKU keyword", () => {
    const longHaikuPrompt = "list " + "a".repeat(2001);
    expect(longHaikuPrompt.length).toBeGreaterThan(2000);
    expect(selectModel(longHaikuPrompt)).toBe(TIERS.OPUS);
  });

  // ── Opus keyword matching ───────────────────────────────────────────────
  it.each(["design", "architect", "refactor across", "security"])(
    "returns OPUS when prompt contains keyword '%s'",
    (kw) => {
      expect(selectModel(`please ${kw} this module`)).toBe(TIERS.OPUS);
    },
  );

  it("keyword matching is case-insensitive", () => {
    expect(selectModel("DESIGN the system")).toBe(TIERS.OPUS);
  });

  // ── Haiku keyword matching (short prompt only) ──────────────────────────
  it.each(["list", "status", "check", "what is", "show"])(
    "returns HAIKU for a short prompt containing keyword '%s'",
    (kw) => {
      expect(selectModel(`${kw} tasks`)).toBe(TIERS.HAIKU);
    },
  );

  it("does NOT return HAIKU when prompt is >= 200 chars even with a haiku keyword", () => {
    const mediumPrompt = "list " + "a".repeat(200);
    expect(selectModel(mediumPrompt)).not.toBe(TIERS.HAIKU);
  });

  // ── precedence: Opus keyword wins over Haiku keyword ────────────────────
  // Documented invariant in model-router.ts: "order matters: check Opus
  // first, then Haiku". A short prompt containing BOTH must resolve to OPUS.
  it("prefers OPUS over HAIKU when a short prompt contains both keywords", () => {
    const prompt = "list the security issues"; // "list" (haiku) + "security" (opus), <200 chars
    expect(prompt.length).toBeLessThan(200);
    expect(selectModel(prompt)).toBe(TIERS.OPUS);
  });

  // ── category-based routing ──────────────────────────────────────────────
  it("returns OPUS for category 'security'", () => {
    expect(selectModel("do something", { category: "security" })).toBe(TIERS.OPUS);
  });

  it("returns SONNET for category 'code-review'", () => {
    expect(selectModel("do something", { category: "code-review" })).toBe(TIERS.SONNET);
  });

  it("returns SONNET for category 'analysis'", () => {
    expect(selectModel("do something", { category: "analysis" })).toBe(TIERS.SONNET);
  });

  it("category matching is case-insensitive", () => {
    expect(selectModel("do something", { category: "Security" })).toBe(TIERS.OPUS);
  });

  // ── precedence: keyword routing wins over category routing ──────────────
  // In model-router.ts the keyword checks (lines 22-26) run BEFORE category
  // routing (lines 29-31). A prompt carrying an Opus keyword must therefore
  // resolve to OPUS even when profileHints supply a SONNET category.
  it("prefers an OPUS keyword over a SONNET category hint", () => {
    expect(selectModel("please design this", { category: "code-review" }))
      .toBe(TIERS.OPUS);
  });

  // Keyword routing (lines 22-26) runs BEFORE category routing (lines 29-31),
  // so a short Haiku-keyword prompt downgrades to HAIKU even when the profile
  // category ("security") would on its own route to OPUS. Pins the cost-
  // sensitive precedence the existing suite leaves untested.
  it("prefers a short HAIKU keyword over an OPUS category hint", () => {
    const prompt = "show me"; // "show" (haiku) + <200 chars
    expect(prompt.length).toBeLessThan(200);
    expect(selectModel(prompt, { category: "security" })).toBe(TIERS.HAIKU);
  });

  // ── default fallback ────────────────────────────────────────────────────
  it("defaults to SONNET when no rule matches", () => {
    expect(selectModel("tell me about the project")).toBe(TIERS.SONNET);
  });

  // ── null / empty / missing prompt ───────────────────────────────────────
  it("handles null prompt gracefully (defaults to SONNET)", () => {
    expect(selectModel(null)).toBe(TIERS.SONNET);
  });

  it("handles empty string prompt gracefully (defaults to SONNET)", () => {
    expect(selectModel("")).toBe(TIERS.SONNET);
  });

  it("handles undefined prompt gracefully (defaults to SONNET)", () => {
    expect(selectModel(undefined)).toBe(TIERS.SONNET);
  });
});
