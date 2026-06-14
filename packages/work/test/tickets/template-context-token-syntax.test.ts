// Token-syntax boundary tests for renderTemplate.
//
// The substitution regex is `/\{\{(\w+)\}\}/g` — it matches ONLY `{{word}}`
// where the key is one-or-more word chars (`[A-Za-z0-9_]`) with no surrounding
// whitespace and no inner delimiters. The existing suites cover known/unknown/
// null/object/falsy/unicode values, but none pin the *shape* the regex accepts.
// These tests lock that contract so a future "be lenient" tweak (e.g. relaxing
// to `\s*([\w.-]+)\s*` or `.+?`) can't silently change which tokens render.
import { describe, it, expect } from "vitest";
import { renderTemplate } from "@zana-ai/work/src/tickets/template-context.ts";

describe("renderTemplate — token syntax boundaries", () => {
  it("does NOT substitute tokens with inner whitespace (left verbatim)", () => {
    // `{{ id }}` has spaces inside the braces → no match → text untouched,
    // even though the context has a matching `id` key.
    expect(renderTemplate("Ticket {{ id }} here", { id: "T-1" })).toBe(
      "Ticket {{ id }} here",
    );
  });

  it("does NOT substitute keys containing hyphens or dots", () => {
    // `\w` excludes `-` and `.`, so these never match and stay literal.
    const ctx = { "user-name": "alice", "a.b": "nested" };
    expect(renderTemplate("{{user-name}} / {{a.b}}", ctx)).toBe(
      "{{user-name}} / {{a.b}}",
    );
  });

  it("ignores single-brace forms and only consumes the {{word}} shape", () => {
    // Single braces are not the delimiter; a valid double-brace token sitting
    // next to literal single braces is the only thing replaced.
    expect(renderTemplate("{id} and {{id}}", { id: "T-7" })).toBe("{id} and T-7");
  });

  it("substitutes underscore and digit keys (still within \\w)", () => {
    // Confirms the boundary is exactly `\w`: `_` and digits DO match.
    expect(
      renderTemplate("{{new_status}}-{{r2}}", { new_status: "done", r2: "ok" }),
    ).toBe("done-ok");
  });
});
