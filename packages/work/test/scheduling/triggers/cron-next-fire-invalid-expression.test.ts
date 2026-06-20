// Direct unit tests for the two cron.ts exports that the existing cron suite
// leaves unasserted:
//   1. nextFireAt() returns null when the expression is invalid (the
//      `if (!validate(expr)) return null;` guard at the top of the function).
//      cron.test.ts only feeds nextFireAt() VALID expressions, and the index
//      wrapper guards before delegating, so this branch was never covered here.
//   2. the `kind` constant — its sibling interval.kind is pinned in
//      interval.test.ts; cron.kind had no equivalent assertion.
//
// node-cron is mocked (same strategy as cron.test.ts) so no real jobs run and
// validate() has deterministic semantics.

import { describe, it, expect, vi } from "vitest";

const mockValidate = (expr: string) =>
  typeof expr === "string" && /^(\S+ ){4,5}\S+$/.test(expr.trim());
vi.mock("node-cron", () => ({
  default: { validate: mockValidate, schedule: vi.fn() },
  validate: mockValidate,
  schedule: vi.fn(),
}));

import * as cron from "@zana-ai/work/src/scheduling/triggers/cron.ts";

describe("cron.nextFireAt() — invalid-expression guard", () => {
  // A fixed `from` keeps the test deterministic (no reliance on the real clock).
  const from = new Date("2026-06-15T12:00:00.000Z");

  it("returns null for a malformed expression instead of scanning", () => {
    expect(cron.nextFireAt("not-a-cron", from)).toBeNull();
  });

  it("returns null for an empty expression", () => {
    expect(cron.nextFireAt("", from)).toBeNull();
  });
});

describe("cron.kind", () => {
  it('equals "cron" so the trigger registry can identify this backend', () => {
    expect(cron.kind).toBe("cron");
  });
});
