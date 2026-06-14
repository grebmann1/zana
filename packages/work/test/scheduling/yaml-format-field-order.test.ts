// Tests for yaml-format.ts behaviors not covered by the main suite:
//   1. Stable field ordering (documented invariant in the module header).
//   2. `enabled: false` preserved — the guard is `!= null`, not truthy, so
//      a disabled schedule must survive a serialize→parse round-trip.
import { describe, it, expect } from "vitest";
import {
  serializeYaml,
  parseYaml,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("serializeYaml — stable field ordering", () => {
  it("emits fields in the documented stable order: id, name, description, enabled, schedule, action, history, ownerId, ownerName, createdAt, updatedAt, status", () => {
    // The module comment says ordering is stable so diffs are readable.
    // We verify by extracting top-level keys from the serialised YAML and
    // checking that any key present appears no earlier than its predecessor.
    const sched = {
      // supply fields deliberately out-of-order
      status: { runCount: 3 },
      updatedAt: "2026-01-02T00:00:00.000Z",
      action: { type: "spawn-agent", profileId: "p", prompt: "go" },
      name: "Ordering test",
      enabled: true,
      schedule: { every: "1h", intervalMs: 3_600_000 },
      id: "order-test",
      createdAt: "2026-01-01T00:00:00.000Z",
      description: "Check field order",
      ownerId: "u-1",
      ownerName: "User One",
      history: { maxEntries: 5 },
    };

    const yaml = serializeYaml(sched);

    // Extract key positions from the raw YAML string.
    const EXPECTED_ORDER = [
      "id",
      "name",
      "description",
      "enabled",
      "schedule",
      "action",
      "history",
      "ownerId",
      "ownerName",
      "createdAt",
      "updatedAt",
      "status",
    ];

    const positions = EXPECTED_ORDER.map((k) => yaml.indexOf(`\n${k}:`));
    const presentPositions = positions.filter((p) => p !== -1);

    // Every consecutive pair of present keys must be in ascending position.
    for (let i = 1; i < presentPositions.length; i++) {
      expect(presentPositions[i]).toBeGreaterThan(presentPositions[i - 1]);
    }
  });
});

describe("serializeYaml — enabled: false is preserved", () => {
  it("round-trips enabled: false without collapsing it to missing/null", () => {
    // The guard is `schedule.enabled != null` — false != null is TRUE, so
    // false must be serialised and survive a parse round-trip.  A regression
    // to a truthy check would silently drop the `enabled` key for disabled
    // schedules, causing the daemon to treat them as enabled.
    const sched = {
      id: "disabled-sched",
      name: "Disabled schedule",
      enabled: false,
      schedule: { every: "5m", intervalMs: 300_000 },
      action: { type: "spawn-agent", profileId: "researcher", prompt: "run" },
    };

    const yaml = serializeYaml(sched);
    const parsed = parseYaml(yaml);

    expect(parsed.enabled).toBe(false);
    // Ensure the key is actually present (not undefined), i.e. it was written.
    expect(Object.prototype.hasOwnProperty.call(parsed, "enabled")).toBe(true);
  });
});
