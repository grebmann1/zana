// Tests for ticket template-context helpers.
import { describe, it, expect } from "vitest";
import {
  buildTemplateContext,
  renderTemplate,
} from "@zana-ai/work/src/tickets/template-context.ts";

const baseTicket = {
  id: "T-1",
  title: "Fix bug",
  status: "in-progress",
  reviewPhase: "qa",
};

describe("buildTemplateContext", () => {
  it("spreads ticket fields into the context", () => {
    const ctx = buildTemplateContext("ticket:statusChanged", {}, baseTicket);
    expect(ctx.id).toBe("T-1");
    expect(ctx.title).toBe("Fix bug");
  });

  it("sets event to the provided event type", () => {
    const ctx = buildTemplateContext("ticket:created", {}, baseTicket);
    expect(ctx.event).toBe("ticket:created");
  });

  it("prefers payload oldStatus / newStatus over ticket status", () => {
    const ctx = buildTemplateContext(
      "ticket:statusChanged",
      { oldStatus: "backlog", newStatus: "in-progress" },
      baseTicket,
    );
    expect(ctx.oldStatus).toBe("backlog");
    expect(ctx.newStatus).toBe("in-progress");
  });

  it("falls back newStatus to ticket.status when payload omits it", () => {
    const ctx = buildTemplateContext("ticket:statusChanged", {}, baseTicket);
    expect(ctx.newStatus).toBe("in-progress");
  });

  it("prefers payload oldPhase / newPhase over ticket reviewPhase", () => {
    const ctx = buildTemplateContext(
      "ticket:reviewPhaseChanged",
      { oldPhase: "qa", newPhase: "architecture" },
      baseTicket,
    );
    expect(ctx.oldPhase).toBe("qa");
    expect(ctx.newPhase).toBe("architecture");
  });

  it("falls back newPhase to ticket.reviewPhase when payload omits it", () => {
    const ctx = buildTemplateContext("ticket:reviewPhaseChanged", {}, baseTicket);
    expect(ctx.newPhase).toBe("qa");
  });

  it("resolves updatedBy from payload fields in priority order", () => {
    expect(
      buildTemplateContext("ticket:updated", { updatedBy: "alice" }, baseTicket).updatedBy,
    ).toBe("alice");
    expect(
      buildTemplateContext("ticket:completed", { completedBy: "bob" }, baseTicket).updatedBy,
    ).toBe("bob");
    expect(
      buildTemplateContext("ticket:commented", { authorId: "carol" }, baseTicket).updatedBy,
    ).toBe("carol");
    expect(
      buildTemplateContext("ticket:claimed", { agentId: "agent-1" }, baseTicket).updatedBy,
    ).toBe("agent-1");
  });

  it("defaults updatedBy to 'system' when no actor is in the payload", () => {
    const ctx = buildTemplateContext("ticket:created", {}, baseTicket);
    expect(ctx.updatedBy).toBe("system");
  });

  it("includes a timestamp ISO string", () => {
    const ctx = buildTemplateContext("ticket:created", {}, baseTicket);
    expect(typeof ctx.timestamp).toBe("string");
    expect(() => new Date(ctx.timestamp)).not.toThrow();
  });

  it("handles null / undefined ticket gracefully", () => {
    const ctx = buildTemplateContext("ticket:created", {}, null);
    expect(ctx.event).toBe("ticket:created");
    expect(ctx.newStatus).toBeNull();
    expect(ctx.newPhase).toBeNull();
  });

  it("handles null payload gracefully", () => {
    const ctx = buildTemplateContext("ticket:created", null, baseTicket);
    expect(ctx.oldStatus).toBeNull();
    expect(ctx.updatedBy).toBe("system");
  });
});

describe("renderTemplate", () => {
  it("replaces known tokens with context values", () => {
    const ctx = { id: "T-1", status: "done" };
    expect(renderTemplate("Ticket {{id}} is {{status}}", ctx)).toBe("Ticket T-1 is done");
  });

  it("replaces unknown tokens with empty string", () => {
    expect(renderTemplate("Hello {{missing}}", {})).toBe("Hello ");
  });

  it("replaces null / undefined values with empty string", () => {
    expect(renderTemplate("Phase: {{phase}}", { phase: null })).toBe("Phase: ");
    expect(renderTemplate("Phase: {{phase}}", { phase: undefined })).toBe("Phase: ");
  });

  it("serialises object values as JSON", () => {
    const ctx = { meta: { a: 1 } };
    expect(renderTemplate("{{meta}}", ctx)).toBe('{"a":1}');
  });

  it("returns empty string when input is not a string", () => {
    expect(renderTemplate(null as any, {})).toBe("");
    expect(renderTemplate(42 as any, {})).toBe("");
  });

  it("leaves text without tokens untouched", () => {
    expect(renderTemplate("no tokens here", { id: "T-1" })).toBe("no tokens here");
  });

  it("replaces multiple occurrences of the same token", () => {
    expect(renderTemplate("{{id}} and {{id}}", { id: "T-2" })).toBe("T-2 and T-2");
  });

  it("handles unicode values in context", () => {
    expect(renderTemplate("{{title}}", { title: "Ünïcödé 🎉" })).toBe("Ünïcödé 🎉");
  });

  it("replaces non-serializable object values (circular refs) with empty string", () => {
    // Exercises the catch { return ""; } branch in the JSON.stringify path
    // (yaml-format.ts line 41 analogue — src line ~41 of template-context.ts).
    const circular: any = {};
    circular.self = circular;
    expect(renderTemplate("value={{circ}}", { circ: circular })).toBe("value=");
  });
});
