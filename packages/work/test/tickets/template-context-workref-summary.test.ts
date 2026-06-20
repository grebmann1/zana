// workRefSummary composition test for buildTemplateContext.
//
// The both-nullish test pins the "not recorded" sentinel (ticket.workRef
// absent). But the POSITIVE path — src lines 28-30, where a workRef OBJECT is
// turned into a human-readable summary — is unpinned. That logic filters out
// missing fields and joins the present ones with ", ", and falls back to
// "recorded but empty" when an object is present but carries no usable field.
// A regression that dropped the .filter(Boolean), changed the join separator,
// or lost the empty-object fallback would slip past every existing test.
import { describe, it, expect } from "vitest";
import { buildTemplateContext } from "@zana-ai/work/src/tickets/template-context.ts";

describe("buildTemplateContext — workRefSummary composition", () => {
  it("joins branch, worktree, and commitRange in order with ', '", () => {
    const ticket = {
      id: "t-1",
      workRef: { branch: "feat/x", worktree: "/tmp/wt", commitRange: "a1b2..c3d4" },
    };
    const ctx = buildTemplateContext("ticket:statusChanged", {}, ticket);
    expect(ctx.workRefSummary).toBe(
      "branch feat/x, worktree /tmp/wt, commits a1b2..c3d4",
    );
  });

  it("omits missing fields and keeps only the present ones", () => {
    const ctx = buildTemplateContext("ticket:statusChanged", {}, {
      id: "t-2",
      workRef: { branch: "feat/y" },
    });
    expect(ctx.workRefSummary).toBe("branch feat/y");
  });

  it("falls back to 'recorded but empty' when the workRef object has no usable field", () => {
    const ctx = buildTemplateContext("ticket:statusChanged", {}, {
      id: "t-3",
      workRef: { branch: "", worktree: "", commitRange: "" },
    });
    expect(ctx.workRefSummary).toBe("recorded but empty");
  });
});
