// Round-trip invariant tests for everShorthandToMs <-> msToEvery in yaml-format.ts.
//
// Each function is well-covered in isolation (yaml-format.test.ts,
// yaml-format-every-edge-cases.test.ts, yaml-format-mstoevery-unit-precedence.test.ts),
// but no existing test asserts the relationship the source documents:
// msToEvery is the "Inverse of everShorthandToMs". These tests lock that contract:
//   (a) ms -> shorthand -> ms recovers the original value exactly, and
//   (b) shorthand -> ms -> shorthand canonicalises to the largest clean unit.

import { describe, it, expect } from "vitest";
import {
  everShorthandToMs,
  msToEvery,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("yaml-format — everShorthandToMs / msToEvery round-trip invariant", () => {
  // Spans every unit plus the sub-second "<n>ms" fallback branch.
  const msValues = [
    250, // ms fallback (not a whole second)
    1000, // 1s
    90_000, // 90s (not a whole minute)
    60_000, // 1m
    5_400_000, // 90m (not a whole hour)
    3_600_000, // 1h
    129_600_000, // 36h (not a whole day)
    86_400_000, // 1d
    2 * 86_400_000, // 2d
  ];

  it("recovers the original ms value through ms -> shorthand -> ms", () => {
    for (const ms of msValues) {
      expect(everShorthandToMs(msToEvery(ms))).toBe(ms);
    }
  });

  it("canonicalises shorthand to the largest clean unit through shorthand -> ms -> shorthand", () => {
    // Non-canonical inputs collapse to their largest-unit form; already-canonical
    // inputs are stable (idempotent).
    expect(msToEvery(everShorthandToMs("60s"))).toBe("1m");
    expect(msToEvery(everShorthandToMs("120m"))).toBe("2h");
    expect(msToEvery(everShorthandToMs("24h"))).toBe("1d");
    expect(msToEvery(everShorthandToMs("1d"))).toBe("1d");
    expect(msToEvery(everShorthandToMs("90s"))).toBe("90s");
  });
});
