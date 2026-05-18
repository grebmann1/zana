import { describe, it, expect } from "vitest";
import { pickBackend, computeNextRunAt, cronBackend } from "@zana/work/src/scheduling/triggers/index.ts";

describe("scheduler-triggers: pickBackend", () => {
  it("picks cron when cron field is present and valid", () => {
    const picked = pickBackend({ schedule: { cron: "*/5 * * * *" } });
    expect(picked).not.toBeNull();
    expect(picked!.kind).toBe("cron");
    expect(picked!.arg).toBe("*/5 * * * *");
  });

  it("picks interval when intervalMs is set", () => {
    const picked = pickBackend({ schedule: { intervalMs: 60_000 } });
    expect(picked).not.toBeNull();
    expect(picked!.kind).toBe("interval");
    expect(picked!.arg).toBe(60_000);
  });

  it("converts every shorthand into intervalMs", () => {
    const picked = pickBackend({ schedule: { every: "5m" } });
    expect(picked).not.toBeNull();
    expect(picked!.kind).toBe("interval");
    expect(picked!.arg).toBe(300_000);
  });

  it("prefers cron over intervalMs when both are set", () => {
    const picked = pickBackend({
      schedule: { cron: "0 0 * * *", intervalMs: 5000 },
    });
    expect(picked!.kind).toBe("cron");
  });

  it("returns null when neither cron nor interval is configured", () => {
    expect(pickBackend({ schedule: {} })).toBeNull();
    expect(pickBackend({})).toBeNull();
  });

  it("returns null on invalid cron expression", () => {
    expect(pickBackend({ schedule: { cron: "definitely not cron" } })).toBeNull();
    expect(pickBackend({ schedule: { cron: "" } })).toBeNull();
  });

  it("supports legacy flat `cron` and `intervalMs` fields", () => {
    const c = pickBackend({ cron: "0 * * * *" });
    expect(c?.kind).toBe("cron");
    const i = pickBackend({ intervalMs: 1000 });
    expect(i?.kind).toBe("interval");
  });
});

describe("scheduler-triggers: cron validate", () => {
  it("accepts valid 5-field expressions", () => {
    expect(cronBackend.validate("* * * * *")).toBe(true);
    expect(cronBackend.validate("0 2 * * *")).toBe(true);
    expect(cronBackend.validate("*/5 * * * *")).toBe(true);
    expect(cronBackend.validate("0 0 * * 0")).toBe(true);
  });

  it("rejects invalid expressions", () => {
    expect(cronBackend.validate("not cron")).toBe(false);
    expect(cronBackend.validate("")).toBe(false);
    // Out-of-range minute
    expect(cronBackend.validate("60 * * * *")).toBe(false);
  });
});

describe("scheduler-triggers: computeNextRunAt", () => {
  it("returns a future ISO string for a cron schedule", () => {
    const next = computeNextRunAt({ schedule: { cron: "* * * * *" } }, new Date("2026-05-18T00:00:00Z"));
    expect(next).toBeTypeOf("string");
    expect(new Date(next!).getTime()).toBeGreaterThan(new Date("2026-05-18T00:00:00Z").getTime());
  });

  it("returns now+intervalMs for interval schedules", () => {
    const from = new Date("2026-05-18T00:00:00Z");
    const next = computeNextRunAt({ schedule: { intervalMs: 60_000 } }, from);
    expect(next).toBe(new Date(from.getTime() + 60_000).toISOString());
  });

  it("returns null when no schedule fields configured", () => {
    expect(computeNextRunAt({})).toBeNull();
  });
});
