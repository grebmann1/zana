// Edge-case tests for renderTemplate's non-string input guard.
// The function's first line is `if (typeof str !== "string") return "";` —
// a boundary guard (CLAUDE.md: validate input at system boundaries). Rule
// actions may pass an absent/malformed `spawnProfile` or `promptTemplate`,
// so a non-string template must collapse to "" rather than throw.
import { describe, it, expect } from "vitest";
import { renderTemplate } from "@zana-ai/work/src/tickets/template-context.ts";

describe("renderTemplate — non-string template input", () => {
  const ctx = { id: "T-1", status: "open" };

  it("returns '' for undefined template", () => {
    expect(renderTemplate(undefined as any, ctx)).toBe("");
  });

  it("returns '' for null template", () => {
    expect(renderTemplate(null as any, ctx)).toBe("");
  });

  it("returns '' for a numeric template", () => {
    expect(renderTemplate(123 as any, ctx)).toBe("");
  });

  it("returns '' for an object template (no throw on .replace)", () => {
    expect(renderTemplate({ foo: "bar" } as any, ctx)).toBe("");
  });

  it("returns '' for an array template", () => {
    expect(renderTemplate(["{{id}}"] as any, ctx)).toBe("");
  });
});
