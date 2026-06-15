// Edge-case test for template-context that complements the main suite.
// Focus: the `catch { return "" }` fallback in renderTemplate's object
// branch. When a token's value is an object that JSON.stringify cannot
// serialise (e.g. a circular reference), renderTemplate must not throw —
// it swallows the error and substitutes an empty string. None of the
// existing object/array serialization tests exercise the throwing path.
import { describe, it, expect } from "vitest";
import { renderTemplate } from "@zana-ai/work/src/tickets/template-context.ts";

describe("renderTemplate — unserialisable object tokens", () => {
  it("substitutes empty string when JSON.stringify throws on a circular object", () => {
    const circular: any = { name: "loop" };
    circular.self = circular; // JSON.stringify throws on this

    // Surrounding literal text is preserved; only the token collapses to "".
    expect(renderTemplate("payload={{circular}}!", { circular })).toBe("payload=!");
  });

  it("does not throw for a circular value and still renders sibling tokens", () => {
    const circular: any = {};
    circular.ref = circular;

    expect(() =>
      renderTemplate("{{id}}/{{circular}}", { id: "T-9", circular }),
    ).not.toThrow();
    expect(renderTemplate("{{id}}/{{circular}}", { id: "T-9", circular })).toBe("T-9/");
  });
});
