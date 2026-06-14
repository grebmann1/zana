import { describe, it, expect } from "vitest";
import { resolveVoters } from "@zana-ai/work/src/deliberation/role-packs.ts";

// ─────────────────────────────────────────────────────────────────────────────
// role-packs — non-finite quantity branch.
//
// resolveVoters normalizes quantity via `Number.isFinite(q) ? floor(q) : 0`,
// so NaN/Infinity collapse to 0 and then trip the `quantity must be >= 1`
// guard. The existing suite covers 0 and fractional inputs but never the
// non-finite path — these assertions lock that branch in.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveVoters — non-finite quantity", () => {
  it("treats NaN as < 1 and throws", () => {
    expect(() => resolveVoters("arch", Number.NaN)).toThrow(/quantity must be >= 1/);
  });

  it("treats Infinity as invalid (not as 'clamp to ladder length') and throws", () => {
    expect(() => resolveVoters("arch", Number.POSITIVE_INFINITY)).toThrow(
      /quantity must be >= 1/,
    );
  });

  it("treats -Infinity as < 1 and throws", () => {
    expect(() => resolveVoters("plan", Number.NEGATIVE_INFINITY)).toThrow(
      /quantity must be >= 1/,
    );
  });
});
