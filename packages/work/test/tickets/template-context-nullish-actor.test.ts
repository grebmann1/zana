// Nullish-vs-falsy boundary for the updatedBy actor resolution in
// buildTemplateContext.
//
// updatedBy is resolved with `??` (nullish coalescing), NOT `||`:
//   p.updatedBy ?? p.completedBy ?? p.authorId ?? p.agentId ?? "system"
// So a present-but-empty-string actor field is a real, intentional value and
// must be PRESERVED — it must not fall through to the next field or to
// "system". The existing suites pin the priority order and the all-absent
// "system" default, but none lock the `??` (empty-string is kept) contract.
// This test guards against a future `??` → `||` switch that would silently
// collapse empty/zero actor ids to "system".
import { describe, it, expect } from "vitest";
import { buildTemplateContext } from "@zana-ai/work/src/tickets/template-context.ts";

const ticket = { id: "T-1", status: "open", reviewPhase: "qa" };

describe("buildTemplateContext — nullish (not falsy) actor resolution", () => {
  it("preserves an empty-string updatedBy instead of falling through to a later field", () => {
    const ctx = buildTemplateContext(
      "ticket:updated",
      { updatedBy: "", completedBy: "beta" },
      ticket,
    );
    // `"" ?? "beta"` === "" — empty string is not nullish, so it wins.
    expect(ctx.updatedBy).toBe("");
  });

  it("preserves an empty-string updatedBy instead of defaulting to 'system'", () => {
    const ctx = buildTemplateContext("ticket:updated", { updatedBy: "" }, ticket);
    expect(ctx.updatedBy).toBe("");
  });

  it("falls through a null updatedBy to the next present actor field", () => {
    // `null ?? "carol"` === "carol" — null IS nullish, so it coalesces.
    const ctx = buildTemplateContext(
      "ticket:commented",
      { updatedBy: null, completedBy: null, authorId: "carol" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("carol");
  });

  it("preserves a falsy-but-defined completedBy when updatedBy is absent", () => {
    const ctx = buildTemplateContext(
      "ticket:completed",
      { completedBy: "", authorId: "gamma" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("");
  });
});
