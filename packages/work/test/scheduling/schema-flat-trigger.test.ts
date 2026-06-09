// schema-flat-trigger — validates the flat (legacy) trigger-field path in
// validateSchedule (src/scheduling/schema.ts lines 87-89).
//
// The function accepts triggers in two forms:
//   (a) nested:  schedule: { cron: "...", every: "5m", intervalMs: 300000 }
//   (b) flat:    cron: "...", every: "5m", intervalMs: 300000   ← top-level
//
// The primary schema tests only exercise the nested form.  This file covers
// every flat-trigger variant to ensure the hasTrigger guard recognises them
// and does NOT emit a "schedule" error for enabled schedules.

import { describe, it, expect } from "vitest";
import { validateSchedule } from "@zana-ai/work/src/scheduling/schema.ts";

const base = () => ({
  id: "flat-test",
  name: "Flat trigger test",
  enabled: true,
  // intentionally no nested `schedule` block
  action: { type: "spawn-agent", profileId: "researcher", prompt: "go" },
});

const scheduleErrors = (s: any) =>
  validateSchedule(s).filter((i) => i.level === "error" && i.field === "schedule");

describe("validateSchedule — flat trigger fields", () => {
  it("accepts a flat top-level cron field as a valid trigger", () => {
    expect(scheduleErrors({ ...base(), cron: "0 * * * *" })).toHaveLength(0);
  });

  it("accepts a flat top-level every field as a valid trigger", () => {
    expect(scheduleErrors({ ...base(), every: "15m" })).toHaveLength(0);
  });

  it("accepts a flat top-level intervalMs field as a valid trigger", () => {
    expect(scheduleErrors({ ...base(), intervalMs: 900_000 })).toHaveLength(0);
  });

  it("accepts a flat trigger alongside an empty nested schedule block", () => {
    // schedule: {} contributes nothing, but the flat `every` satisfies hasTrigger.
    expect(scheduleErrors({ ...base(), schedule: {}, every: "5m" })).toHaveLength(0);
  });

  it("still rejects an enabled schedule with neither flat nor nested trigger", () => {
    // Baseline regression: no trigger at all must still produce a schedule error.
    expect(scheduleErrors({ ...base() })).toHaveLength(1);
  });

  it("still accepts a disabled schedule with no trigger at all", () => {
    // enabled: false schedules are manual-only — trigger is optional.
    expect(scheduleErrors({ ...base(), enabled: false })).toHaveLength(0);
  });
});
