// serializeYaml must silently drop fields that are not part of the known
// schema so that unknown/extra properties injected by callers (or carried
// over from older on-disk formats) never propagate back to the YAML file.
// This is an important sanitization invariant: only the documented fields
// (id, name, description, enabled, schedule, action, history, ownerId,
//  ownerName, createdAt, updatedAt, status) are preserved.
import { describe, it, expect } from "vitest";
import {
  serializeYaml,
  parseYaml,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("serializeYaml — unknown fields are stripped", () => {
  it("drops arbitrary top-level extra fields from the output", () => {
    const input = {
      id: "s-unknown",
      name: "Extra fields schedule",
      enabled: true,
      schedule: { every: "5m" },
      action: { type: "spawn-agent", profileId: "researcher", prompt: "run" },
      // Extra fields that must NOT appear in serialised output:
      hackerField: "should-be-gone",
      internalMeta: { secret: true },
      __proto__: "not real",
    };

    const yaml = serializeYaml(input as any);

    // Raw YAML string must not contain any of the extra key names.
    expect(yaml).not.toContain("hackerField");
    expect(yaml).not.toContain("internalMeta");

    // Round-trip: parsed object must also be free of the extra fields.
    const parsed = parseYaml(yaml);
    expect(parsed).toBeDefined();
    expect((parsed as any).hackerField).toBeUndefined();
    expect((parsed as any).internalMeta).toBeUndefined();

    // Known fields are still present.
    expect(parsed.id).toBe("s-unknown");
    expect(parsed.name).toBe("Extra fields schedule");
    expect(parsed.enabled).toBe(true);
    expect(parsed.schedule?.every).toBe("5m");
  });

  it("does not bleed unknown fields even when every known field is present", () => {
    const input = {
      id: "full",
      name: "Full schedule",
      description: "desc",
      enabled: true,
      schedule: { every: "1h" },
      action: { type: "spawn-agent", profileId: "p", prompt: "go" },
      history: { maxEntries: 10 },
      ownerId: "u-1",
      ownerName: "Alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: { runCount: 5 },
      // Extra fields mixed in alongside known ones:
      extraA: "x",
      extraB: 42,
    };

    const parsed = parseYaml(serializeYaml(input as any));
    expect((parsed as any).extraA).toBeUndefined();
    expect((parsed as any).extraB).toBeUndefined();
    // All known fields survived.
    expect(parsed.id).toBe("full");
    expect(parsed.status?.runCount).toBe(5);
  });
});
