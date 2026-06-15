// Case-insensitivity test for everShorthandToMs in yaml-format.ts.
//
// The unit regex carries the /i flag (/^\s*(\d+)\s*(ms|s|m|h|d)\s*$/i) and the
// matched unit is normalized via m[2].toLowerCase() before the switch. No
// existing test file exercises uppercase or mixed-case units — the main
// yaml-format.test.ts and yaml-format-every-edge-cases.test.ts only use
// lowercase shorthand ("5m", "1h", "500ms", ...). A regression dropping the /i
// flag or the .toLowerCase() call would silently reject perfectly valid
// uppercase shorthand, so pin the behavior here.
//
// Pure function, no timers / network / globals → fully deterministic.

import { describe, it, expect } from "vitest";
import { everShorthandToMs } from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("everShorthandToMs — case-insensitive units", () => {
  it("parses uppercase units identically to lowercase", () => {
    expect(everShorthandToMs("500MS")).toBe(500);
    expect(everShorthandToMs("30S")).toBe(30_000);
    expect(everShorthandToMs("5M")).toBe(300_000);
    expect(everShorthandToMs("2H")).toBe(7_200_000);
    expect(everShorthandToMs("3D")).toBe(259_200_000);
  });

  it("parses mixed-case units (e.g. 'Ms')", () => {
    expect(everShorthandToMs("250Ms")).toBe(250);
    expect(everShorthandToMs("250mS")).toBe(250);
  });

  it("yields the same value regardless of unit casing", () => {
    expect(everShorthandToMs("10M")).toBe(everShorthandToMs("10m"));
    expect(everShorthandToMs("1H")).toBe(everShorthandToMs("1h"));
  });
});
