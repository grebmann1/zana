// Single-pass / no-recursive-interpolation guard for renderTemplate.
//
// renderTemplate substitutes via one `String.prototype.replace(/.../g, fn)`
// pass: the regex scans the ORIGINAL string once and the text returned by the
// replacer is NOT re-scanned. That means a token whose *value* itself contains
// `{{otherKey}}` syntax must be emitted verbatim — never expanded a second time.
//
// This is a correctness AND safety invariant: ticket fields (titles, comment
// bodies, work refs) flow into reviewer/worker prompt templates via this
// renderer. If interpolation recursed, a user-controlled field containing
// `{{updatedBy}}` (or any context key) would be silently rewritten — a template
// injection. The existing suites pin which token SHAPES match and how values
// are stringified, but none lock the single-pass contract. This file closes
// that gap so a future switch to a recursive/loop-until-stable renderer can't
// land unnoticed.
import { describe, it, expect } from "vitest";
import { renderTemplate } from "@zana-ai/work/src/tickets/template-context.ts";

describe("renderTemplate — single pass, no recursive interpolation", () => {
  it("emits a value that contains {{token}} syntax verbatim (not re-expanded)", () => {
    // `a` resolves to a string that looks like another token. A single-pass
    // renderer leaves it literal; a recursive one would expand it to "second".
    const ctx = { a: "{{b}}", b: "second" };
    expect(renderTemplate("{{a}}", ctx)).toBe("{{b}}");
  });

  it("does not let a user-controlled field inject another context key (no template injection)", () => {
    // Realistic flow: a ticket title is spread into the template context, then a
    // reviewer prompt template references {{title}}. A malicious title that
    // embeds {{updatedBy}} must render as literal text, NOT resolve the actor.
    const ctx = { title: "Investigate {{updatedBy}} report", updatedBy: "alice" };
    const out = renderTemplate("Task: {{title}}", ctx);
    expect(out).toBe("Task: Investigate {{updatedBy}} report");
    expect(out).not.toContain("alice");
  });

  it("renders every original token in one pass without rescanning replacements", () => {
    // Both tokens come from the ORIGINAL string and are replaced; the `{{y}}`
    // introduced by x's value is part of a replacement and so is left alone.
    const ctx = { x: "<{{y}}>", y: "Y", z: "Z" };
    expect(renderTemplate("{{x}} {{z}}", ctx)).toBe("<{{y}}> Z");
  });
});
