import { describe, it, expect } from "vitest";

import {
  serializeYaml,
  parseYaml,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

// serializeYaml lifts legacy flat root fields (`cron`, `intervalMs`) into the
// nested `schedule` block — but ONLY when the nested block does not already
// carry that field. Lines 46-52 of yaml-format.ts guard the lift with
// `!sched.cron` / `!sched.intervalMs`, so an explicit nested value must WIN
// over a stale legacy flat one rather than being clobbered by it.
//
// Existing tests cover the two halves in isolation (flat-only fields get
// lifted; an already-nested block round-trips) but never the CONFLICT case
// where both forms are present at once. A regression that dropped the
// `!sched.cron` guard — lifting the flat field unconditionally and overwriting
// the nested one — would pass every current test. This locks the precedence.
// Pure function: deterministic, no clock, no I/O.

describe("serializeYaml — nested schedule block wins over legacy flat fields", () => {
  it("keeps the nested cron / intervalMs and ignores conflicting flat root fields", () => {
    const sched = {
      id: "conflict",
      name: "Conflicting schedule",
      // Authoritative nested block.
      schedule: { cron: "0 0 * * *", intervalMs: 1000 },
      // Stale legacy flat fields that must NOT override the nested block.
      cron: "*/5 * * * *",
      intervalMs: 9999,
      action: { type: "spawn-agent", profileId: "worker", prompt: "go" },
    };

    const parsed = parseYaml(serializeYaml(sched));

    // Nested values survive verbatim.
    expect(parsed.schedule.cron).toBe("0 0 * * *");
    expect(parsed.schedule.intervalMs).toBe(1000);

    // The conflicting flat values are neither lifted nor left at the root.
    expect(parsed.schedule.cron).not.toBe("*/5 * * * *");
    expect(parsed.schedule.intervalMs).not.toBe(9999);
    expect(parsed.cron).toBeUndefined();
    expect(parsed.intervalMs).toBeUndefined();
  });
});
