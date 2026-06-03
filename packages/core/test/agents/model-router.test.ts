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
