// Regression guard for the `!Number.isInteger(r)` branch of history.retain
// validation in validateSchedule.
//
// The existing schema suite pins the out-of-range branches (retain: -1 and
// retain: HISTORY_RETAIN_MAX + 1) — both INTEGERS — and the non-numeric path
// only via resolveHistoryConfig. A fractional but in-range value (e.g. 5.5)
// reaches `validateSchedule` through the integer guard alone; no current test
// fails if that guard were dropped. This test pins it down, plus the
// non-numeric retain error path that validateSchedule (not resolveHistoryConfig)
// is responsible for.
import { describe, it, expect } from "vitest";
import { validateSchedule } from "@zana-ai/work/src/scheduling/schema.ts";

const valid = () => ({
  id: "test",
  name: "Test",
  enabled: true,
  schedule: { every: "5m" },
  action: { type: "spawn-agent", profileId: "researcher", prompt: "hi" },
});

const retainErrors = (raw: any) =>
  validateSchedule(raw).filter(
    (i) => i.level === "error" && i.field === "history.retain",
  );

describe("validateSchedule — history.retain integer guard", () => {
  it("rejects an in-range but fractional retain", () => {
    // 5.5 is within [0, MAX] yet not an integer — must error via Number.isInteger.
    expect(retainErrors({ ...valid(), history: { retain: 5.5 } })).toHaveLength(1);
  });

  it("rejects a non-numeric retain", () => {
    expect(retainErrors({ ...valid(), history: { retain: "ten" } as any })).toHaveLength(1);
  });

  it("accepts a valid integer retain with no retain error", () => {
    expect(retainErrors({ ...valid(), history: { retain: 5 } })).toEqual([]);
  });
});
