// role-packs-generalist-invariant.test.ts
//
// Verifies the contract documented at the top of role-packs.ts:
//
//   "Packs cooperate by including `researcher` at quantity≥3 so the
//    quorum generalist-seat invariant (quorum.ts) is a no-op on packed
//    councils."
//
// Also covers the non-finite quantity guard in resolveVoters (NaN /
// Infinity / -Infinity) and two normalizeVotersInput paths that were
// previously untested (unknown pack propagation; null input).

import { describe, it, expect } from "vitest";
import {
  resolveVoters,
  normalizeVotersInput,
} from "@zana-ai/work/src/deliberation/role-packs.ts";

const ALL_PACKS = ["arch", "code-review", "plan", "review"] as const;

// ─── generalist-seat invariant ──────────────────────────────────────────────

describe("resolveVoters — generalist-seat invariant", () => {
  it("researcher is present in every pack at quantity=3", () => {
    for (const pack of ALL_PACKS) {
      const voters = resolveVoters(pack, 3);
      expect(voters, `pack=${pack} qty=3 → ${JSON.stringify(voters)}`).toContain(
        "researcher",
      );
    }
  });

  it("researcher is present in every pack at the full ladder depth (quantity=5)", () => {
    for (const pack of ALL_PACKS) {
      const voters = resolveVoters(pack, 5);
      expect(voters, `pack=${pack} qty=5 → ${JSON.stringify(voters)}`).toContain(
        "researcher",
      );
    }
  });

  it("review pack is generalist-first: researcher occupies slot 0 at quantity=1", () => {
    // review is the only pack where generalist arrives even at qty=1.
    const voters = resolveVoters("review", 1);
    expect(voters).toHaveLength(1);
    expect(voters[0]).toBe("researcher");
  });

  it("plan pack places researcher at slot index 1 so it arrives at quantity=2", () => {
    // plan reviews are heavier on context — generalist lands one slot earlier
    // than arch/code-review (which require qty=3).
    const voters = resolveVoters("plan", 2);
    expect(voters).toHaveLength(2);
    expect(voters[1]).toBe("researcher");
  });
});

// ─── non-finite quantity guard ───────────────────────────────────────────────

describe("resolveVoters — non-finite quantity guard", () => {
  // The source normalises quantity via:
  //   typeof q === "number" && Number.isFinite(q) ? Math.floor(q) : 0
  // then throws when the result is < 1.  Without this guard, Math.min /
  // Array#slice would silently produce an empty array or unexpected output.

  it("throws on NaN quantity", () => {
    expect(() => resolveVoters("arch", NaN)).toThrow(/quantity must be >= 1/);
  });

  it("throws on Infinity quantity", () => {
    expect(() => resolveVoters("arch", Infinity)).toThrow(/quantity must be >= 1/);
  });

  it("throws on -Infinity quantity", () => {
    expect(() => resolveVoters("arch", -Infinity)).toThrow(/quantity must be >= 1/);
  });
});

// ─── normalizeVotersInput edge paths ────────────────────────────────────────

describe("normalizeVotersInput — additional edge paths", () => {
  const defaults = ["researcher", "code-reviewer"];

  it("propagates resolveVoters error when pack id is unknown", () => {
    // Callers that pass `{ pack: "typo-pack" }` get a clear 'unknown role pack'
    // error rather than a silent empty array or a confusing secondary failure.
    expect(() =>
      normalizeVotersInput({ pack: "nonexistent-pack" }, defaults),
    ).toThrow(/unknown role pack/);
  });

  it("throws the voters-must-be error when input is null", () => {
    // null is not undefined, not an Array, and not a {pack} object — it must
    // fall through to the throw branch rather than producing undefined behaviour.
    expect(() =>
      normalizeVotersInput(null as any, defaults),
    ).toThrow(/voters must be/);
  });
});
