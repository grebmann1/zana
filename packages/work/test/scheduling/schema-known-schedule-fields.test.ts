// Regression guard for SCHEDULE_BLOCK_FIELDS membership.
//
// The existing schema suite only proves that an UNKNOWN schedule.* field
// (`typo`) warns, and exercises `every` via the shared valid() fixture. It
// never asserts that the full known set — cron / every / intervalMs — is
// accepted WITHOUT a "unknown schedule field" warning. If any of those three
// were dropped from SCHEDULE_BLOCK_FIELDS, no current test would fail. This
// test pins each known field down individually.
import { describe, it, expect } from "vitest";
import {
  validateSchedule,
  SCHEDULE_BLOCK_FIELDS,
} from "@zana-ai/work/src/scheduling/schema.ts";

const base = () => ({
  id: "test",
  name: "Test",
  enabled: true,
  action: { type: "spawn-agent", profileId: "researcher", prompt: "hi" },
});

const scheduleWarnings = (raw: any) =>
  validateSchedule(raw).filter(
    (i) => i.level === "warning" && i.field.startsWith("schedule."),
  );

describe("validateSchedule — known schedule.* fields", () => {
  for (const field of SCHEDULE_BLOCK_FIELDS) {
    it(`does not warn on the known schedule field "${field}"`, () => {
      const issues = scheduleWarnings({
        ...base(),
        schedule: { [field]: "5m" },
      });
      expect(issues).toEqual([]);
    });
  }

  it("accepts cron, every and intervalMs together with no schedule.* warnings", () => {
    const issues = scheduleWarnings({
      ...base(),
      schedule: { cron: "*/5 * * * *", every: "5m", intervalMs: 300000 },
    });
    expect(issues).toEqual([]);
  });
});
