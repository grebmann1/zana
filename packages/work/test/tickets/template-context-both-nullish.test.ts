// Both-nullish guard test for buildTemplateContext.
//
// src lines 22/24 guard each input independently: `const p = payload || {}`
// and `...(ticket || {})`. The main suite (template-context.test.ts) exercises
// a null TICKET with a valid `{}` payload, and a null PAYLOAD with a valid
// ticket — but never both nullish at the SAME time, so the case where both
// guards fire together is unpinned. A regression that dropped one guard (e.g.
// spreading `...ticket` directly, or reading `payload.oldStatus` without the
// `|| {}`) would throw on a null input yet still pass every existing test.
//
// When both inputs are absent the function must still return a fully-formed,
// non-throwing context: every reserved key present, status/phase fallbacks
// collapsing to null, updatedBy defaulting to "system", and a fresh valid
// ISO-8601 timestamp.
import { describe, it, expect } from "vitest";
import { buildTemplateContext } from "@zana-ai/work/src/tickets/template-context.ts";

describe("buildTemplateContext — both payload and ticket nullish", () => {
  it("returns a fully-formed context when payload is null AND ticket is null", () => {
    const ctx = buildTemplateContext("ticket:created", null, null);
    expect(ctx.event).toBe("ticket:created");
    expect(ctx.oldStatus).toBeNull();
    expect(ctx.newStatus).toBeNull();
    expect(ctx.oldPhase).toBeNull();
    expect(ctx.newPhase).toBeNull();
    expect(ctx.updatedBy).toBe("system");
    // Fresh, valid ISO-8601 instant — round-trips through Date unchanged.
    expect(new Date(ctx.timestamp).toISOString()).toBe(ctx.timestamp);
  });

  it("does not throw and adds no ticket-derived keys when both inputs are undefined", () => {
    const ctx = buildTemplateContext("ticket:updated", undefined, undefined);
    expect(ctx.event).toBe("ticket:updated");
    expect(ctx.newStatus).toBeNull();
    expect(ctx.updatedBy).toBe("system");
    // No ticket was spread in, so only the reserved keys exist. `workRefSummary`
    // is always added (collapsing to the "not recorded" sentinel when ticket is
    // nullish), so it belongs to the reserved set alongside the other seven.
    expect(Object.keys(ctx).sort()).toEqual(
      ["event", "newPhase", "newStatus", "oldPhase", "oldStatus", "timestamp", "updatedBy", "workRefSummary"].sort(),
    );
  });
});
