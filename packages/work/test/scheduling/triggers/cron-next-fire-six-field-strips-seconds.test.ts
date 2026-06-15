// nextFireAt() — a 6-field cron must DROP the leading seconds field, not
// consume it as the minute field.
//
// cron.ts supports 6-field expressions by `fields.slice(1)` (cron.ts:73),
// reinterpreting "sec min hour dom mon dow" as the 5-field "min hour dom mon dow".
// The existing 6-field case in cron.test.ts uses "0 */5 * * * *" and only
// asserts `minutes % 5 === 0` — which still passes even if the seconds field
// were NOT stripped (a misparse would set min=0, and 0 % 5 === 0). So the
// "seconds is actually dropped" invariant is unpinned: a refactor that removed
// the slice would keep every current test green.
//
// This pins it with an expression whose stripped vs. misparsed interpretations
// land on different fire times:
//   "0 15 10 * * *"  stripped → "15 10 * * *"  → fires at 10:15
//   misparse as 5-field      → min=0, hour=15, dom=10 → fires 15:00 on the 10th
//
// All three calls go through the same nextFireAt() local-time scan, so the
// equalities are timezone-independent. node-cron is mocked (no real jobs).

import { describe, it, expect, vi } from "vitest";

// ── mock node-cron before importing the module under test ─────────────────
const mockValidate = (expr: string) =>
  typeof expr === "string" && /^(\S+ ){4,5}\S+$/.test(expr.trim());
vi.mock("node-cron", () => ({
  default: { validate: mockValidate, schedule: vi.fn() },
  validate: mockValidate,
  schedule: vi.fn(),
}));

import * as cron from "@zana-ai/work/src/scheduling/triggers/cron.ts";

describe("nextFireAt — 6-field expression strips the seconds field", () => {
  const from = new Date("2026-06-15T00:00:00.000Z");

  it("equals the 5-field equivalent (seconds dropped, not read as minute)", () => {
    const sixField = cron.nextFireAt("0 15 10 * * *", from);
    const fiveFieldEquivalent = cron.nextFireAt("15 10 * * *", from);

    expect(sixField).toBeTruthy();
    expect(sixField).toBe(fiveFieldEquivalent);
  });

  it("does NOT match the naive 5-field misparse of the same tokens", () => {
    const sixField = cron.nextFireAt("0 15 10 * * *", from);
    // If the seconds field were kept, the tokens would be read as
    // min=0, hour=15, dom=10 — a different fire time.
    const misparse = cron.nextFireAt("0 15 10 * *", from);

    expect(sixField).not.toBe(misparse);
  });
});
