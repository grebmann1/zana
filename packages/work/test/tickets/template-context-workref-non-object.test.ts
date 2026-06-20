// workRefSummary guard test for buildTemplateContext.
//
// The composition test (template-context-workref-summary) pins the OBJECT
// path, and the both-nullish test pins the absent path. But the guard on
// src line 28 — `wr && typeof wr === "object"` — also has to cope with a
// workRef that is *present but not a record*: a stray string, number, or
// array left in the ticket store. A regression that dropped the
// `typeof === "object"` check would either throw on `wr.branch` (string has
// no such field but `(123).branch` is undefined while indexing a string char
// works oddly) or, for arrays, silently emit "recorded but empty" for a value
// that carries no usable branch/worktree/commitRange. These cases pin that
// only a real record object yields a composed summary; everything else is
// treated as "not recorded" or "recorded but empty" without throwing.
import { describe, it, expect } from "vitest";
import { buildTemplateContext } from "@zana-ai/work/src/tickets/template-context.ts";

const NOT_RECORDED =
  "not recorded — inspect the checked-out tree, and if you cannot find the work there, record INCONCLUSIVE rather than FAIL";

describe("buildTemplateContext — workRefSummary with a non-record workRef", () => {
  it("treats a string workRef as 'not recorded' (typeof guard, no throw)", () => {
    const ctx = buildTemplateContext("ticket:statusChanged", {}, {
      id: "t-str",
      workRef: "feat/x",
    });
    expect(ctx.workRefSummary).toBe(NOT_RECORDED);
  });

  it("treats a numeric workRef as 'not recorded'", () => {
    const ctx = buildTemplateContext("ticket:statusChanged", {}, {
      id: "t-num",
      workRef: 42,
    });
    expect(ctx.workRefSummary).toBe(NOT_RECORDED);
  });

  it("does not throw on an array workRef and yields no composed branch summary", () => {
    const ctx = buildTemplateContext("ticket:statusChanged", {}, {
      id: "t-arr",
      workRef: ["feat/x"],
    });
    // An array is typeof "object", so it passes the guard but carries no
    // branch/worktree/commitRange field → falls back to the empty sentinel.
    expect(ctx.workRefSummary).toBe("recorded but empty");
  });
});
