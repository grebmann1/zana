// End-to-end integration for template-context.ts.
//
// The module docstring states its whole reason for existing:
//   "so prompts can reference bus payload fields like {{oldStatus}} and
//    {{updatedBy}}, not just ticket fields."
//
// The existing suite covers buildTemplateContext() and renderTemplate()
// SEPARATELY and exhaustively, plus one integration that renders ticket
// fields ({{id}}, {{labels}}). What is NOT pinned anywhere is the actual
// documented use case: feeding a `ticket:statusChanged` bus payload through
// buildTemplateContext() and then rendering a prompt template that references
// the PAYLOAD-DERIVED reserved keys ({{oldStatus}}, {{newStatus}},
// {{updatedBy}}) — not ticket fields. A regression that broke the payload →
// reserved-key → render wiring would slip past every existing test.
//
// Deterministic: pure functions, no network, no real Claude. The volatile
// {{timestamp}} field is asserted only for shape (ISO string), never value.

import { describe, it, expect } from "vitest";
import {
  buildTemplateContext,
  renderTemplate,
} from "@zana-ai/work/src/tickets/template-context.ts";

describe("template-context — renders payload-derived fields end-to-end", () => {
  it("renders {{oldStatus}}/{{newStatus}}/{{updatedBy}} from a statusChanged payload, not from ticket fields", () => {
    const ticket = { id: "T-42", status: "in-progress", reviewPhase: null };
    const payload = {
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "worker-7",
    };

    const ctx = buildTemplateContext("ticket:statusChanged", payload, ticket);
    const prompt = renderTemplate(
      "Ticket {{id}} moved {{oldStatus}} -> {{newStatus}} by {{updatedBy}} (event={{event}})",
      ctx,
    );

    expect(prompt).toBe(
      "Ticket T-42 moved in-progress -> review by worker-7 (event=ticket:statusChanged)",
    );
  });

  it("renders an empty replacement for {{oldStatus}} when the payload omits it (defaults to null)", () => {
    // oldStatus has no ticket fallback — when absent it is null, and
    // renderTemplate maps null to an empty string.
    const ticket = { id: "T-1", status: "review", reviewPhase: "qa" };
    const ctx = buildTemplateContext("ticket:created", {}, ticket);

    const prompt = renderTemplate(
      "from[{{oldStatus}}] to[{{newStatus}}] by[{{updatedBy}}]",
      ctx,
    );

    // newStatus falls back to ticket.status; updatedBy defaults to "system";
    // oldStatus stays empty.
    expect(prompt).toBe("from[] to[review] by[system]");
  });
});
