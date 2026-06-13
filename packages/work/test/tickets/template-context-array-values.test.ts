// Edge-case tests for template-context that complement the main suite.
// Focus: array-valued tokens in renderTemplate. Arrays hit the same
// `typeof v === "object"` → JSON.stringify branch as plain objects, but
// serialize to a JSON *array* string. This is the realistic shape for a
// ticket's `labels` field flowing through buildTemplateContext, which the
// existing object-serialization test (a plain `{a:1}`) does not exercise.
import { describe, it, expect } from "vitest";
import {
  buildTemplateContext,
  renderTemplate,
} from "@zana-ai/work/src/tickets/template-context.ts";

describe("renderTemplate — array-valued tokens", () => {
  it("serialises a string array as a JSON array string", () => {
    expect(renderTemplate("labels={{labels}}", { labels: ["bug", "urgent"] })).toBe(
      'labels=["bug","urgent"]',
    );
  });

  it("serialises an empty array as []", () => {
    expect(renderTemplate("labels={{labels}}", { labels: [] })).toBe("labels=[]");
  });

  it("renders a ticket's labels array spread through buildTemplateContext", () => {
    // labels is a non-reserved ticket field, so it passes through the spread
    // unchanged and then serialises via the object branch in renderTemplate.
    const ctx = buildTemplateContext(
      "ticket:updated",
      {},
      { id: "T-1", status: "review", labels: ["qa", "p1"] },
    );
    expect(renderTemplate("[{{id}}] {{labels}}", ctx)).toBe('[T-1] ["qa","p1"]');
  });
});
