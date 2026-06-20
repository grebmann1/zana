// Clock-injection test for buildTemplateContext's `timestamp` field.
//
// src line 31 sets `timestamp: new Date().toISOString()`. Every existing test
// asserts the timestamp only for SHAPE (a round-trippable ISO-8601 string) and
// never for VALUE — see template-context.test.ts ("includes a timestamp ISO
// string") and the `new Date(ctx.timestamp).toISOString() === ctx.timestamp`
// round-trip checks. That leaves the actual behavior — "timestamp reflects the
// current instant" — unpinned. A regression that hard-coded a constant, reused
// the ticket's createdAt, or shifted the value (e.g. `Date.now() + offset`)
// would still produce a valid ISO string and pass every current test.
//
// By injecting a fixed clock we can assert the EXACT value, making the
// "stamps the present moment" contract observable and deterministic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildTemplateContext } from "@zana-ai/work/src/tickets/template-context.ts";

describe("buildTemplateContext — timestamp uses the current clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the exact current instant as an ISO-8601 string", () => {
    const fixed = new Date("2026-06-16T17:43:21.000Z");
    vi.setSystemTime(fixed);

    const ctx = buildTemplateContext("ticket:created", {}, { status: "open" });

    expect(ctx.timestamp).toBe("2026-06-16T17:43:21.000Z");
  });

  it("reflects clock advancement between successive calls", () => {
    vi.setSystemTime(new Date("2026-06-16T00:00:00.000Z"));
    const first = buildTemplateContext("ticket:updated", {}, {});

    vi.advanceTimersByTime(5_000);
    const second = buildTemplateContext("ticket:updated", {}, {});

    expect(first.timestamp).toBe("2026-06-16T00:00:00.000Z");
    expect(second.timestamp).toBe("2026-06-16T00:00:05.000Z");
  });
});
