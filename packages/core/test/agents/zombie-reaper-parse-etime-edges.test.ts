// zombie-reaper — parseEtime() robustness branches.
//
// The sibling zombie-reaper.test.ts pins the four canonical ps `etime` forms
// (SS, MM:SS, HH:MM:SS, DD-HH:MM:SS) plus a wholly-garbage input. This file
// covers the per-field coercion branches that the happy-path forms leave
// untested — parseEtime is pure (no clock, no fs, no process state), so these
// are fully deterministic.
//
// Why it matters: parseEtime feeds the reaper's grace-window decision (how long
// an orphaned process has been alive). A NaN leaking out of one corrupt field
// would poison the whole elapsed-time arithmetic (NaN compares false against
// any threshold), so each field's `Number(p) || 0` fallback and the
// length-based branch selection are load-bearing for not mis-reaping — or
// failing to reap — a process whose `etime` string is partially malformed.

import { describe, it, expect } from "vitest";
import { parseEtime } from "@zana-ai/core/src/agents/zombie-reaper.ts";

describe("parseEtime — field-coercion robustness", () => {
  // Number("") === 0, parts = [0], single-component → seconds branch → 0.
  // Pins that an empty string yields a numeric 0, never NaN.
  it("returns 0 for an empty string", () => {
    expect(parseEtime("")).toBe(0);
  });

  // A corrupt seconds field must coerce to 0 (via `Number(p) || 0`) instead of
  // NaN-poisoning the sum — the minutes field still contributes.
  it("coerces a non-numeric field to 0 rather than producing NaN", () => {
    const result = parseEtime("05:zz"); // MM=5, SS=garbage→0
    expect(result).toBe(300);
    expect(Number.isNaN(result)).toBe(false);
  });

  // The days segment is parsed with `Number(...) || 0`, so a non-numeric value
  // before the dash drops to 0 days while the HH:MM:SS remainder still parses.
  it("coerces a non-numeric days segment to 0 days", () => {
    expect(parseEtime("x-05:30")).toBe(5 * 60 + 30); // 330
  });

  // Inputs with MORE than three colon-separated components match none of the
  // length===3/2/1 branches, so every component is ignored and the result falls
  // through to 0. Pins that over-long (malformed) input is treated as 0 elapsed,
  // not silently mis-summed.
  it("returns 0 when there are more than three colon-separated components", () => {
    expect(parseEtime("1:2:3:4")).toBe(0);
  });
});
