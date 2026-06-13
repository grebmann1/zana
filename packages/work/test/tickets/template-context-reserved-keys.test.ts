// Reserved-key precedence tests for buildTemplateContext.
//
// buildTemplateContext spreads the ticket first, then sets the computed
// context fields (event, oldStatus, newStatus, oldPhase, newPhase, updatedBy,
// timestamp) as later literal properties. Later properties win, so a ticket
// whose own fields collide with these reserved keys must NOT be able to
// override the values derived from the event type / payload. This is a
// correctness + anti-spoofing invariant: rule prompts that reference
// {{event}} or {{updatedBy}} must reflect the real event, not arbitrary
// ticket-stored values.
import { describe, it, expect } from "vitest";
import { buildTemplateContext } from "@zana-ai/work/src/tickets/template-context.ts";

describe("buildTemplateContext — reserved-key precedence over ticket fields", () => {
  // A ticket that tries to override every computed key.
  const spoofTicket = {
    id: "T-1",
    title: "real title",
    status: "open",
    reviewPhase: "qa",
    event: "ticket:SPOOFED",
    oldStatus: "spoof-old",
    newStatus: "spoof-new",
    oldPhase: "spoof-old-phase",
    newPhase: "spoof-new-phase",
    updatedBy: "attacker",
    timestamp: "not-a-real-timestamp",
  };

  it("computed 'event' wins over a same-named ticket field", () => {
    const ctx = buildTemplateContext("ticket:created", {}, spoofTicket);
    expect(ctx.event).toBe("ticket:created");
  });

  it("'updatedBy' is derived from payload, not the ticket field", () => {
    const ctx = buildTemplateContext("ticket:updated", { updatedBy: "alice" }, spoofTicket);
    expect(ctx.updatedBy).toBe("alice");
  });

  it("'updatedBy' falls back to 'system' (not the ticket field) when payload has no actor", () => {
    const ctx = buildTemplateContext("ticket:created", {}, spoofTicket);
    expect(ctx.updatedBy).toBe("system");
  });

  it("'newStatus' resolves from payload/ticket.status, ignoring a spoofed ticket.newStatus", () => {
    const ctx = buildTemplateContext("ticket:statusChanged", {}, spoofTicket);
    // payload omits newStatus → falls back to ticket.status ("open"),
    // never the spread ticket.newStatus ("spoof-new").
    expect(ctx.newStatus).toBe("open");
  });

  it("'newPhase' resolves from payload/ticket.reviewPhase, ignoring a spoofed ticket.newPhase", () => {
    const ctx = buildTemplateContext("ticket:reviewPhaseChanged", {}, spoofTicket);
    expect(ctx.newPhase).toBe("qa");
  });

  it("'oldStatus'/'oldPhase' default to null (not the ticket field) when payload omits them", () => {
    const ctx = buildTemplateContext("ticket:statusChanged", {}, spoofTicket);
    expect(ctx.oldStatus).toBeNull();
    expect(ctx.oldPhase).toBeNull();
  });

  it("'timestamp' is a freshly generated ISO string, not the ticket field", () => {
    const ctx = buildTemplateContext("ticket:created", {}, spoofTicket);
    expect(ctx.timestamp).not.toBe("not-a-real-timestamp");
    // Round-trips through Date as a valid ISO-8601 instant.
    expect(new Date(ctx.timestamp).toISOString()).toBe(ctx.timestamp);
  });

  it("non-reserved ticket fields still pass through unchanged", () => {
    const ctx = buildTemplateContext("ticket:created", {}, spoofTicket);
    expect(ctx.id).toBe("T-1");
    expect(ctx.title).toBe("real title");
  });
});
