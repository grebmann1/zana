// pickBackend — every path that returns null
//
// The happy-path cases (valid cron, valid intervalMs, valid every shorthand)
// are already covered in index.test.ts.  This file pins the null-return
// contract so a future refactor cannot silently break it.

import { describe, it, expect } from "vitest";
import { pickBackend } from "@zana-ai/work/src/scheduling/triggers/index.ts";

describe("pickBackend — null-return paths", () => {
  it("returns null for a null schedule", () => {
    expect(pickBackend(null as any)).toBeNull();
  });

  it("returns null for an undefined schedule", () => {
    expect(pickBackend(undefined as any)).toBeNull();
  });

  it("returns null for an empty object (no trigger fields)", () => {
    expect(pickBackend({})).toBeNull();
  });

  it("returns null when cron expression is present but fails validate()", () => {
    // "99 99 99 99 99" is truthy so the cron branch is entered,
    // but cronBackend.validate() returns false → pickBackend must return null.
    expect(pickBackend({ schedule: { cron: "99 99 99 99 99" } })).toBeNull();
  });

  it("returns null when intervalMs is exactly zero (not > 0)", () => {
    expect(pickBackend({ schedule: { intervalMs: 0 } })).toBeNull();
  });

  it("returns null when intervalMs is negative", () => {
    expect(pickBackend({ schedule: { intervalMs: -60_000 } })).toBeNull();
  });

  it("returns null when every shorthand is malformed (cannot be converted)", () => {
    // everShorthandToMs throws for unrecognised strings; the catch in
    // readScheduleBlock sets intervalMs = null, so pickBackend returns null.
    expect(pickBackend({ schedule: { every: "not-a-duration" } })).toBeNull();
  });

  it("returns null when flat (non-nested) intervalMs is zero", () => {
    expect(pickBackend({ intervalMs: 0 })).toBeNull();
  });
});
