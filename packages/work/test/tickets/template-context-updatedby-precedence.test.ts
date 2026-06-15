// Precedence tests for buildTemplateContext's `updatedBy` resolution.
//
// src line 30 resolves the actor via a `??` chain:
//   p.updatedBy ?? p.completedBy ?? p.authorId ?? p.agentId ?? "system"
// The main suite checks each field in isolation, but never with SEVERAL
// actor fields present at once — so the relative priority of the chain is
// unpinned. These tests lock that ordering so a future reorder of the chain
// (or a switch to `||`, which would change null/empty-string handling) can't
// silently change which actor wins.
import { describe, it, expect } from "vitest";
import { buildTemplateContext } from "@zana-ai/work/src/tickets/template-context.ts";

const ticket = { id: "T-1", status: "review", reviewPhase: "qa" };

describe("buildTemplateContext — updatedBy precedence", () => {
  it("updatedBy wins over all lower-priority actor fields", () => {
    const ctx = buildTemplateContext(
      "ticket:updated",
      { updatedBy: "u", completedBy: "c", authorId: "a", agentId: "g" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("u");
  });

  it("completedBy wins when updatedBy is absent", () => {
    const ctx = buildTemplateContext(
      "ticket:completed",
      { completedBy: "c", authorId: "a", agentId: "g" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("c");
  });

  it("authorId wins over agentId when both higher fields are absent", () => {
    const ctx = buildTemplateContext(
      "ticket:commented",
      { authorId: "a", agentId: "g" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("a");
  });

  it("uses `??` semantics: an explicit null in a higher field falls through", () => {
    // `??` (not `||`) means only null/undefined fall through. A null
    // updatedBy must yield the next defined actor, not "system".
    const ctx = buildTemplateContext(
      "ticket:updated",
      { updatedBy: null, completedBy: "c" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("c");
  });

  it("preserves a falsy-but-defined actor value (empty string is NOT skipped)", () => {
    // With `??`, an empty-string updatedBy is a defined value and wins;
    // a `||` chain would incorrectly skip it down to "system".
    const ctx = buildTemplateContext(
      "ticket:updated",
      { updatedBy: "", agentId: "g" },
      ticket,
    );
    expect(ctx.updatedBy).toBe("");
  });
});
