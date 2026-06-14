// Tests for serializeYaml silent-drop behaviour when optional fields that are
// expected to be objects are actually non-object values (string, number, etc.).
// The source guards are:
//   if (schedule.history && typeof schedule.history === "object") { ... }
//   if (schedule.schedule && typeof schedule.schedule === "object") { ... }
// Both guards should silently omit the field rather than throwing or writing
// a garbage value — callers rely on absence to detect unconfigured schedules.

import { describe, it, expect } from "vitest";
import {
  serializeYaml,
  parseYaml,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

const BASE = {
  id: "s-1",
  name: "test",
  action: { type: "spawn-agent", profileId: "p1" },
};

describe("serializeYaml — non-object history field", () => {
  it("omits the history key when history is a string", () => {
    const yaml = serializeYaml({ ...BASE, history: "daily" });
    const parsed = parseYaml(yaml);
    expect(parsed).not.toHaveProperty("history");
  });

  it("omits the history key when history is a number", () => {
    const yaml = serializeYaml({ ...BASE, history: 42 });
    const parsed = parseYaml(yaml);
    expect(parsed).not.toHaveProperty("history");
  });

  it("omits the history key when history is null", () => {
    const yaml = serializeYaml({ ...BASE, history: null });
    const parsed = parseYaml(yaml);
    expect(parsed).not.toHaveProperty("history");
  });

  it("preserves history when it IS a valid object", () => {
    const yaml = serializeYaml({ ...BASE, history: { maxRuns: 10 } });
    const parsed = parseYaml(yaml);
    expect(parsed.history).toEqual({ maxRuns: 10 });
  });
});

describe("serializeYaml — non-object schedule.schedule field", () => {
  it("omits the schedule block when schedule.schedule is a string", () => {
    const yaml = serializeYaml({ ...BASE, schedule: "daily" });
    const parsed = parseYaml(yaml);
    // schedule field will be absent (no sub-keys were extracted)
    expect(parsed.schedule == null || Object.keys(parsed.schedule ?? {}).length === 0).toBe(true);
  });

  it("omits the schedule block when schedule.schedule is a number", () => {
    const yaml = serializeYaml({ ...BASE, schedule: 86400000 });
    const parsed = parseYaml(yaml);
    expect(parsed.schedule == null || Object.keys(parsed.schedule ?? {}).length === 0).toBe(true);
  });

  it("still extracts flat cron/intervalMs even when schedule.schedule is non-object", () => {
    // Legacy flat fields on the root are still honoured regardless.
    const yaml = serializeYaml({ ...BASE, schedule: "bad", cron: "0 * * * *" });
    const parsed = parseYaml(yaml);
    expect(parsed.schedule?.cron).toBe("0 * * * *");
  });
});
