// Focused boundary test for normalizeVotersInput's empty-array branch.
//
// normalizeVotersInput distinguishes two "no explicit voters" shapes:
//   - input === undefined → fall back to a COPY of `defaults`
//   - input === []        → an explicit (if empty) array, passed THROUGH
//
// The Array.isArray(input) branch runs before any length check, so `[]`
// yields zero voters rather than the defaults. That asymmetry is the whole
// point: an explicit empty list is a caller decision ("no voters"), not the
// same as omitting the argument. A regression that "helpfully" treated `[]`
// as omitted would silently re-introduce the defaults and flip the contract.
// The existing suite pins the `undefined` path and the populated-array path,
// but never the empty-array boundary between them.

import { describe, it, expect } from "vitest";
import { normalizeVotersInput } from "@zana-ai/work/src/deliberation/role-packs.ts";

describe("normalizeVotersInput — empty array is an explicit (zero-voter) choice, not a fallback", () => {
  const defaults = ["researcher", "code-reviewer"];

  it("returns the empty array as-is and does NOT fall back to defaults", () => {
    expect(normalizeVotersInput([], defaults)).toEqual([]);
  });

  it("passes the SAME empty-array reference through (no defensive copy on the array path)", () => {
    const input: string[] = [];
    expect(normalizeVotersInput(input, defaults)).toBe(input);
  });

  it("leaves the provided defaults untouched when given an empty array", () => {
    normalizeVotersInput([], defaults);
    expect(defaults).toEqual(["researcher", "code-reviewer"]);
  });
});
