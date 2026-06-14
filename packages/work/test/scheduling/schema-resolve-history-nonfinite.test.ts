// schema-resolve-history-nonfinite — pins a subtle branch in
// resolveHistoryConfig (scheduling/schema.ts).
//
// retain is accepted only when `typeof === "number" && Number.isFinite(...)`.
// Infinity and NaN are both `typeof "number"` but NOT finite, so they must
// fall back to the DEFAULT retain — NOT be clamped to HISTORY_RETAIN_MAX.
// This distinguishes the Number.isFinite() guard from a bare typeof check:
// without it, Math.floor(Infinity) would clamp to MAX, a very different result.
// The existing "ignores non-numeric retain" case only covers a string, which
// fails the typeof check and never exercises the finite guard.

import { describe, it, expect } from "vitest";
import {
  resolveHistoryConfig,
  HISTORY_DEFAULTS,
  HISTORY_RETAIN_MAX,
} from "@zana-ai/work/src/scheduling/schema.ts";

describe("resolveHistoryConfig — non-finite retain falls back to default", () => {
  it("treats Infinity as non-finite → default retain (not clamped to MAX)", () => {
    const { retain } = resolveHistoryConfig({ history: { retain: Infinity } });
    expect(retain).toBe(HISTORY_DEFAULTS.retain);
    expect(retain).not.toBe(HISTORY_RETAIN_MAX);
  });

  it("treats -Infinity as non-finite → default retain (not clamped to 0)", () => {
    const { retain } = resolveHistoryConfig({ history: { retain: -Infinity } });
    expect(retain).toBe(HISTORY_DEFAULTS.retain);
  });

  it("treats NaN as non-finite → default retain", () => {
    const { retain } = resolveHistoryConfig({ history: { retain: NaN } });
    expect(retain).toBe(HISTORY_DEFAULTS.retain);
  });

  it("preserves an explicit enabled flag while retain falls back", () => {
    const cfg = resolveHistoryConfig({
      history: { enabled: false, retain: Infinity },
    });
    expect(cfg).toEqual({ enabled: false, retain: HISTORY_DEFAULTS.retain });
  });
});
