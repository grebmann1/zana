// Contract test for the daemon-managed schedule fields.
//
// schema.ts documents that DAEMON_MANAGED_FIELDS are overwritten on every run.
// Because the daemon writes them back into the persisted YAML, validateSchedule
// MUST recognize every one of them as a legal top-level field — otherwise a
// round-tripped schedule would surface spurious "unknown field" warnings on the
// daemon's own bookkeeping. This test pins that invariant so adding a new
// daemon-managed field without also listing it in TOP_LEVEL_FIELDS fails loudly.
import { describe, it, expect } from "vitest";
import {
  validateSchedule,
  DAEMON_MANAGED_FIELDS,
  STATUS_MANAGED_SUBFIELDS,
  TOP_LEVEL_FIELDS,
} from "@zana-ai/work/src/scheduling/schema.ts";

// A minimal valid schedule with plausible values for every daemon-managed field.
const withDaemonFields = () => ({
  id: "test",
  name: "Test",
  enabled: true,
  schedule: { every: "5m" },
  action: { type: "spawn-agent", profileId: "researcher", prompt: "hi" },
  createdAt: "2026-06-13T00:00:00.000Z",
  updatedAt: "2026-06-13T00:00:00.000Z",
  status: { consecutiveErrors: 0, autoDisabledReason: null },
  lastRunAt: "2026-06-13T00:00:00.000Z",
  lastRunResult: "success",
  nextRunAt: "2026-06-13T00:05:00.000Z",
  runCount: 3,
});

describe("daemon-managed field contract", () => {
  it("validateSchedule emits no 'unknown field' warning for any daemon-managed field", () => {
    const issues = validateSchedule(withDaemonFields());
    const flagged = issues
      .filter((i) => i.level === "warning")
      .map((i) => i.field);
    for (const field of DAEMON_MANAGED_FIELDS) {
      expect(flagged).not.toContain(field);
    }
  });

  it("every daemon-managed field is also a recognized top-level field", () => {
    for (const field of DAEMON_MANAGED_FIELDS) {
      expect(TOP_LEVEL_FIELDS as readonly string[]).toContain(field);
    }
  });

  it("the run-tracking status subfields are managed both at top level and inside status", () => {
    // These four are written both as legacy flat fields and under `status`,
    // so they must appear in both lists per the documented contract.
    for (const sub of ["lastRunAt", "lastRunResult", "nextRunAt", "runCount"]) {
      expect(DAEMON_MANAGED_FIELDS).toContain(sub);
      expect(STATUS_MANAGED_SUBFIELDS).toContain(sub);
    }
  });
});
