// renderTemplate() token-grammar contract.
//
// The renderer matches tokens with /\{\{(\w+)\}\}/g — the capture group is
// `\w+` (ASCII word chars only). This deliberately does NOT support dotted /
// nested paths, unlike workflow-engine.ts's interpolatePrompt() which uses
// `\w+(?:\.\w+)*`. The existing template-context.test.ts pins the happy path
// (single-word tokens) but never the negative space: tokens containing a dot,
// whitespace, or hyphen must be left in the string verbatim — they are not
// tokens as far as this renderer is concerned.
//
// Pinning this guards against a future "make it support nested paths" change
// silently leaking blanks where literal text is expected (and keeps the two
// renderers' grammars intentionally distinct).
import { describe, it, expect } from "vitest";
import { renderTemplate } from "@zana-ai/work/src/tickets/template-context.ts";

describe("renderTemplate — non-word tokens are left literal", () => {
  it("leaves a dotted/nested token untouched (no nested-path resolution)", () => {
    // `\w+` stops at the dot, so "{{ticket.id}}" never matches and is emitted
    // verbatim — even though `ticket` exists in the context.
    const ctx = { ticket: { id: "T-1" } };
    expect(renderTemplate("id={{ticket.id}}", ctx)).toBe("id={{ticket.id}}");
  });

  it("does not substitute a dotted token even when the leading word is a key", () => {
    const ctx = { ticket: "whole" };
    expect(renderTemplate("{{ticket.id}}", ctx)).toBe("{{ticket.id}}");
  });

  it("leaves a token with inner whitespace untouched", () => {
    expect(renderTemplate("{{ id }}", { id: "T-1" })).toBe("{{ id }}");
  });

  it("leaves a hyphenated token untouched (hyphen is not a word char)", () => {
    expect(renderTemplate("{{ticket-id}}", { "ticket-id": "T-1" })).toBe("{{ticket-id}}");
  });

  it("still substitutes a plain word token in the same string as a dotted one", () => {
    // Mixed string: the bare word token resolves, the dotted token does not.
    const ctx = { status: "done", ticket: { id: "T-1" } };
    expect(renderTemplate("{{status}}:{{ticket.id}}", ctx)).toBe("done:{{ticket.id}}");
  });
});
