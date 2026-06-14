// Direct unit tests for cron.validate().
//
// The existing cron.test.ts exercises validate() only indirectly through
// start() (which calls validate() internally and throws when it returns false).
// This file pins the exported validate() return-value contract so the early-
// guard branches (non-string, empty string, whitespace-only) and the
// nodeCron-throws path are explicitly covered.

import { describe, it, expect, vi } from "vitest";

// ── mock node-cron before the module under test is imported ─────────────────
// Same strategy as cron.test.ts: accept any 5- or 6-field whitespace-separated
// expression as "valid", throw for the special sentinel "THROW".
const mockValidateFn = vi.fn((expr: string) => {
  if (expr === "THROW") throw new Error("node-cron internal error");
  return /^(\S+ ){4,5}\S+$/.test(expr.trim());
});

vi.mock("node-cron", () => ({
  default: { validate: mockValidateFn, schedule: vi.fn() },
  validate: mockValidateFn,
  schedule: vi.fn(),
}));

import { validate } from "@zana-ai/work/src/scheduling/triggers/cron.ts";

describe("cron.validate()", () => {
  it("returns true for a well-formed 5-field expression", () => {
    expect(validate("*/5 * * * *")).toBe(true);
  });

  it("returns true for a well-formed 6-field expression", () => {
    expect(validate("0 */5 * * * *")).toBe(true);
  });

  it("returns false for an invalid expression (wrong field count)", () => {
    expect(validate("not-a-cron")).toBe(false);
  });

  it("returns false for a non-string argument (number)", () => {
    expect(validate(42 as any)).toBe(false);
  });

  it("returns false for a non-string argument (null)", () => {
    expect(validate(null as any)).toBe(false);
  });

  it("returns false for a non-string argument (undefined)", () => {
    expect(validate(undefined as any)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(validate("")).toBe(false);
  });

  it("returns false for a whitespace-only string", () => {
    // trim() reduces it to length 0 — the early guard fires before nodeCron.
    expect(validate("   ")).toBe(false);
  });

  it("returns false when nodeCron.validate throws (catch branch)", () => {
    // The special sentinel "THROW" makes our mock throw — validates the
    // `catch { return false; }` branch in the source.
    expect(validate("THROW")).toBe(false);
  });

  it("does NOT call nodeCron.validate when the early guard fires", () => {
    mockValidateFn.mockClear();
    validate(null as any);
    validate(undefined as any);
    validate("");
    validate("   ");
    // All four calls hit the early-return guard, so the mock must NOT be invoked.
    expect(mockValidateFn).not.toHaveBeenCalled();
  });
});
