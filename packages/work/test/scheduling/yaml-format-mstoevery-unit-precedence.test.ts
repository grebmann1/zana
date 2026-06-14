// Unit-precedence tests for msToEvery in yaml-format.ts.
//
// The "picks the largest clean unit" test in yaml-format.test.ts only exercises
// exact single-unit multiples (1d, 1h, 1m, 1s), and yaml-format-every-edge-cases
// covers multi-day values and the sub-second "<n>ms" fallback. Neither file
// covers the discriminating branch: a value that is a clean multiple of a
// SMALLER unit but NOT of a larger one. msToEvery walks units largest→smallest
// and returns on the first clean division, so these cases prove it both:
//   (a) prefers the larger unit when the value divides it cleanly, and
//   (b) skips a larger unit and falls to the next when it does NOT divide.

import { describe, it, expect } from "vitest";
import { msToEvery } from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("msToEvery — unit precedence across boundaries", () => {
  it("prefers the larger unit even when smaller units also divide cleanly", () => {
    // 7_200_000 is a clean multiple of hour (2h), minute (120m) and second.
    // Walking largest→smallest must stop at hours.
    expect(msToEvery(7_200_000)).toBe("2h");
  });

  it("falls to minutes when the value is not a whole number of hours", () => {
    // 90 minutes: 5_400_000 % 3_600_000 === 1_800_000 (not whole hours),
    // but 5_400_000 % 60_000 === 0 → "90m".
    expect(msToEvery(5_400_000)).toBe("90m");
  });

  it("falls to seconds when the value is not a whole number of minutes", () => {
    // 90 seconds: 90_000 % 60_000 === 30_000 (not whole minutes),
    // but 90_000 % 1000 === 0 → "90s".
    expect(msToEvery(90_000)).toBe("90s");
  });

  it("falls to hours when the value is not a whole number of days", () => {
    // 36 hours: 129_600_000 % 86_400_000 === 43_200_000 (not whole days),
    // but 129_600_000 % 3_600_000 === 0 → "36h".
    expect(msToEvery(129_600_000)).toBe("36h");
  });
});
