// Edge-case tests for template-context that complement the main suite.
// Focus: falsy-but-non-null token values in renderTemplate, and simultaneous
// actor-field priority in buildTemplateContext.
import { describe, it, expect } from "vitest";
import {
  buildTemplateContext,
  renderTemplate,
} from "@zana-ai/work/src/tickets/template-context.ts";

describe("renderTemplate — falsy-but-non-null values", () => {
  it("renders boolean false as the string 'false'", () => {
    // The guard is `=== null || === undefined`, so false must pass through
    // String(v) rather than being collapsed to "".
    expect(renderTemplate("enabled={{val}}", { val: false })).toBe("enabled=false");
  });

  it("renders numeric 0 as the string '0'", () => {
    expect(renderTemplate("count={{val}}", { val: 0 })).toBe("count=0");
  });

  it("renders empty string value as an empty replacement (not omitted)", () => {
    // An empty-string value is neither null nor undefined, so it should
    // produce an empty token replacement, not leave the braces intact.
    expect(renderTemplate("status={{val}}", { val: "" })).toBe("status=");
  });

  it("renders numeric NaN as the string 'NaN'", () => {
    // NaN is a number, not null/undefined — String(NaN) === "NaN".
    expect(renderTemplate("score={{val}}", { val: NaN })).toBe("score=NaN");
  });
});

describe("buildTemplateContext — simultaneous actor-field priority", () => {
  const ticket = { id: "T-99", status: "backlog", reviewPhase: null };

  it("updatedBy wins over completedBy when both are present", () => {
    const ctx = buildTemplateContext(
      "ticket:completed",
      { updatedBy: "alpha", completedBy: "beta" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("alpha");
  });

  it("completedBy wins over authorId when updatedBy is absent", () => {
    const ctx = buildTemplateContext(
      "ticket:completed",
      { completedBy: "beta", authorId: "gamma" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("beta");
  });

  it("authorId wins over agentId when updatedBy and completedBy are absent", () => {
    const ctx = buildTemplateContext(
      "ticket:commented",
      { authorId: "gamma", agentId: "delta" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("gamma");
  });

  it("agentId is used when it is the only actor field present", () => {
    const ctx = buildTemplateContext(
      "ticket:claimed",
      { agentId: "delta" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("delta");
  });

  it("all four fields present — updatedBy has top priority", () => {
    const ctx = buildTemplateContext(
      "ticket:updated",
      { updatedBy: "a", completedBy: "b", authorId: "c", agentId: "d" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("a");
  });
});
