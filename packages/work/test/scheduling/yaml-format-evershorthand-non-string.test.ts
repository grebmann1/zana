// everShorthandToMs — non-string-input guard.
//
// Line 1 of everShorthandToMs is `if (typeof s !== "string") throw new
// Error("...not a string...")`. Every existing test passes a string (valid
// shorthand, or an invalid one like "abc"/"1.5m" that fails the regex and
// throws "invalid shorthand"). None passes a NON-string, so the dedicated
// typeof guard — and its distinct error message — is unexercised. A caller
// can reach this path by feeding a parsed-YAML `every:` value that came back
// as a number, null, or object instead of a string.
import { describe, it, expect } from "vitest";
import { everShorthandToMs } from "@zana-ai/work/src/scheduling/yaml-format.ts";

describe("everShorthandToMs — non-string inputs hit the typeof guard", () => {
  it("throws 'not a string' for a number, not 'invalid shorthand'", () => {
    // A number must trip the typeof guard BEFORE the regex match is attempted.
    expect(() => everShorthandToMs(5 as any)).toThrow(/not a string/);
    expect(() => everShorthandToMs(5 as any)).not.toThrow(/invalid shorthand/);
  });

  it("throws 'not a string' for null", () => {
    expect(() => everShorthandToMs(null as any)).toThrow(/not a string/);
  });

  it("throws 'not a string' for undefined", () => {
    expect(() => everShorthandToMs(undefined as any)).toThrow(/not a string/);
  });

  it("throws 'not a string' for an object", () => {
    expect(() => everShorthandToMs({ every: "5m" } as any)).toThrow(/not a string/);
  });
});
