import { describe, it, expect } from "vitest";
import { selectModel, TIERS } from "@zana-ai/core/src/agents/model-router.ts";

describe("model-router — selectModel", () => {
  // ── explicit user override ──────────────────────────────────────────────
  it("returns the explicit model from profileHints regardless of prompt", () => {
    expect(selectModel("design a secure architecture", { model: "my-custom-model" }))
      .toBe("my-custom-model");
  });

  // ── precedence: explicit override wins over the length fast path ─────────
  // The `profileHints.model` override (model-router.ts line 14) is checked
  // BEFORE the `len > 2000` Opus fast path (line 20). A user who pins an
  // explicit model must keep it even for a huge prompt that would otherwise be
  // auto-upgraded to OPUS. The existing override test only pins override-vs-
  // keyword; this pins override-vs-length against a check-reordering regression.
  it("respects an explicit model override even for a >2000-char prompt", () => {
    const longPrompt = "x".repeat(2001);
    expect(selectModel(longPrompt, { model: "my-custom-model" }))
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

  // ── precedence: length fast path wins over a category hint ──────────────
  // The `len > 2000` OPUS fast path (model-router.ts line 20) runs BEFORE
  // category routing (lines 29-31). A >2000-char prompt must therefore route to
  // OPUS even when profileHints carry a cheaper SONNET category — a big task
  // must not be downgraded by a category hint. The sibling length-precedence
  // test pins length-vs-HAIKU-keyword only; this pins length-vs-category, the
  // arm that would silently misroute if category were reordered ahead of length.
  it("routes a >2000-char prompt to OPUS even with a SONNET category hint", () => {
    const longPrompt = "x".repeat(2001);
    expect(selectModel(longPrompt, { category: "code-review" })).toBe(TIERS.OPUS);
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

  // ── Opus keyword is the full phrase "refactor across", not bare "refactor" ──
  // model-router.ts lists "refactor across" (not "refactor") as an OPUS keyword
  // and matches via substring `text.includes(kw)`. A plain single-file refactor
  // request must therefore NOT be upgraded to the most expensive tier — it has
  // no Opus/Haiku keyword and falls through to the SONNET default. Pins the
  // cost invariant against a regression that splits the phrase into "refactor".
  it("does NOT route a bare 'refactor' prompt to OPUS (only 'refactor across')", () => {
    expect(selectModel("refactor this single file")).toBe(TIERS.SONNET);
    // The full phrase still upgrades to OPUS.
    expect(selectModel("refactor across the whole codebase")).toBe(TIERS.OPUS);
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

  // ── exact length boundary of the `len < 200` HAIKU gate ─────────────────
  // model-router.ts gates the cheap tier on `len < 200` (strict). The suite
  // covers a 205-char prompt and tiny prompts but never the off-by-one edge.
  // A 199-char Haiku-keyword prompt must downgrade to HAIKU; bumping it to
  // exactly 200 must NOT (200 < 200 is false → falls through to SONNET).
  // Pins the precise cost boundary against an accidental `<=` regression.
  it("treats the 200-char HAIKU gate as strict (199 → HAIKU, 200 → not)", () => {
    const at199 = "list" + "a".repeat(195); // len 199, contains "list"
    const at200 = "list" + "a".repeat(196); // len 200, contains "list"
    expect(at199.length).toBe(199);
    expect(at200.length).toBe(200);
    expect(selectModel(at199)).toBe(TIERS.HAIKU);
    expect(selectModel(at200)).not.toBe(TIERS.HAIKU);
    expect(selectModel(at200)).toBe(TIERS.SONNET);
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

  // Category routing keys off exact membership in OPUS_CATEGORIES /
  // SONNET_CATEGORIES (model-router.ts lines 30-31), so a category in NEITHER
  // list must fall through to the default. The neutral prompt below trips no
  // keyword or length rule, isolating the category arm: the result pins that an
  // unrecognized category does NOT accidentally route to OPUS and lands on the
  // SONNET default. The existing suite only exercises recognized categories.
  it("falls through to SONNET for an unrecognized category hint", () => {
    expect(selectModel("do something", { category: "frontend" })).toBe(TIERS.SONNET);
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
