// Edge-case tests for everShorthandToMs / msToEvery in yaml-format.ts.
//
// The main yaml-format.test.ts covers exact single-unit values (1d, 1h, 1m,
// 1s, 500ms) and basic invalid inputs ("abc", "0m", "-5m", null).
// The following realistic paths are NOT covered by any existing test file:
//
//   everShorthandToMs:
//     - float-like shorthand ("1.5m") — regex only accepts \d+, must throw
//
//   msToEvery:
//     - multi-day value (2d, 3d) — "largest clean unit" logic for ms > 1d
//     - sub-second non-divisible value (750ms) — must fall through to the
//       "<n>ms" fallback because 750 % 1000 !== 0

import { describe, it, expect } from "vitest";
import {
  everShorthandToMs,
  msToEvery,
} from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("everShorthandToMs — float-like shorthands", () => {
  it("rejects '1.5m' (decimal — not an integer digit sequence)", () => {
    // The regex /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/i requires \d+ (digits only),
    // so "1.5m" never matches and must throw "invalid shorthand".
    expect(() => everShorthandToMs("1.5m")).toThrow(/invalid shorthand/);
  });

  it("rejects '0.5h' (decimal hours)", () => {
    expect(() => everShorthandToMs("0.5h")).toThrow(/invalid shorthand/);
  });

  it("rejects '2.0s' (decimal seconds even though value is whole)", () => {
    // The .0 causes the regex to fail regardless of the numeric value.
    expect(() => everShorthandToMs("2.0s")).toThrow(/invalid shorthand/);
  });
});

describe("msToEvery — multi-day values", () => {
  it("returns '2d' for exactly 2 days in milliseconds", () => {
    // 2 * 86_400_000 = 172_800_000; divides cleanly into days → "2d"
    expect(msToEvery(2 * 86_400_000)).toBe("2d");
  });

  it("returns '3d' for exactly 3 days in milliseconds", () => {
    expect(msToEvery(3 * 86_400_000)).toBe("3d");
  });

  it("prefers days over hours for clean multiples of 86_400_000", () => {
    // 172_800_000 is both 2d and 48h; the function tries 'd' first, so "2d"
    // must be returned, not "48h".
    expect(msToEvery(172_800_000)).toBe("2d");
  });
});

describe("msToEvery — sub-second non-divisible fallback", () => {
  it("returns '750ms' for 750 milliseconds (not a clean second multiple)", () => {
    // 750 % 1000 = 750 ≠ 0, so the function falls through all unit checks
    // and emits the raw millisecond count as "<n>ms".
    expect(msToEvery(750)).toBe("750ms");
  });

  it("returns '1500ms' for 1500 ms (1.5 s — not a clean second boundary)", () => {
    // 1500 % 1000 = 500 ≠ 0; expected fallback to "1500ms".
    expect(msToEvery(1500)).toBe("1500ms");
  });
});
