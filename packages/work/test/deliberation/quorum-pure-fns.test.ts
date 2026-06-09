// Focused edge-case tests for the two pure helper functions in quorum.ts:
//   resolveQuorum  — zero-candidate boundaries, invalid-spec throw
//   applyDegradation — anti-dropout-bias negative path, empty-dissenter list
//
// The main quorum.test.ts already covers the happy-path and integration
// scenarios; this file targets the branches that remain uncovered there.
import { describe, it, expect } from "vitest";
import {
  resolveQuorum,
  applyDegradation,
  applyGeneralistSeatInvariant,
} from "@zana-ai/work/src/deliberation/quorum.ts";
import type { GeneralistSeatConfig } from "@zana-ai/work/src/deliberation/quorum.ts";
import type { Voter } from "@zana-ai/work/src/deliberation/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// resolveQuorum — zero-candidate and invalid-spec boundaries
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveQuorum — zero-candidate and invalid-spec boundaries", () => {
  it('majority of 0 candidates clamps to 1 (cannot make majority of nothing)', () => {
    expect(resolveQuorum("majority", 0)).toBe(1);
  });

  it('"all" of 0 candidates clamps to 1 (Math.max(1, 0))', () => {
    expect(resolveQuorum("all", 0)).toBe(1);
  });

  it("numeric spec with 0 candidates returns Math.max(1, spec) — ensures quorum is always at least 1", () => {
    // candidateCount=0 → clamp up to Math.max(1, q)
    expect(resolveQuorum(1, 0)).toBe(1);
    expect(resolveQuorum(5, 0)).toBe(5);
  });

  it("non-finite numeric spec throws", () => {
    expect(() => resolveQuorum(NaN as any, 3)).toThrow(/invalid spec/);
    expect(() => resolveQuorum(Infinity as any, 3)).toThrow(/invalid spec/);
  });

  it("unknown string spec throws a descriptive error", () => {
    expect(() => resolveQuorum("weekly" as any, 3)).toThrow(/invalid spec/);
    expect(() => resolveQuorum("" as any, 3)).toThrow(/invalid spec/);
    expect(() => resolveQuorum(null as any, 3)).toThrow(/invalid spec/);
  });

  it('"all" with positive n equals n (exact — no off-by-one)', () => {
    expect(resolveQuorum("all", 1)).toBe(1);
    expect(resolveQuorum("all", 7)).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyDegradation — anti-dropout-bias NEGATIVE path
// ─────────────────────────────────────────────────────────────────────────────
describe("applyDegradation — anti-dropout-bias negative path", () => {
  const twoVoters: Voter[] = [
    { agentId: "ag-a", profileId: "a", modelId: "m" },
    { agentId: "ag-b", profileId: "b", modelId: "m" },
  ];

  it("previous dissenters listed but none are in the dropped set — does NOT escalate on dropout_was_dissenter", () => {
    // c was a previous dissenter, but c was NOT dropped (only d was).
    const dropped = [{ profileId: "d", reason: "timeout" as const, detail: "..." }];
    const decision = applyDegradation(twoVoters, dropped, {
      candidateCount: 3,
      quorum: 2,
      previousDissenterProfileIds: ["c"],
    });
    // Anti-bias rule must not fire when the dissenter survived.
    expect(decision.decision).toBe("READY");
    expect(decision.reason).toBeUndefined();
  });

  it("empty previousDissenterProfileIds with drops — falls through to quorum check, not dropout_was_dissenter", () => {
    const dropped = [{ profileId: "b", reason: "spawn" as const, detail: "..." }];
    const oneVoter: Voter[] = [{ agentId: "ag-a", profileId: "a", modelId: "m" }];
    // quorum=2, only 1 survivor → quorum_lost (not dropout_was_dissenter)
    const decision = applyDegradation(oneVoter, dropped, {
      candidateCount: 2,
      quorum: 2,
      previousDissenterProfileIds: [],
    });
    expect(decision.decision).toBe("ESCALATED");
    expect(decision.reason).toBe("quorum_lost");
  });

  it("undefined previousDissenterProfileIds treated as empty — falls through to quorum check", () => {
    const dropped = [{ profileId: "b", reason: "timeout" as const, detail: "..." }];
    // quorum=1, 1 survivor → READY even though drops exist
    const decision = applyDegradation(twoVoters.slice(0, 1), dropped, {
      candidateCount: 2,
      quorum: 1,
      previousDissenterProfileIds: undefined,
    });
    expect(decision.decision).toBe("READY");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyGeneralistSeatInvariant — built-in profile fallback (Slice B, line 156)
//
// When resolveProfile(cfg.profileId) returns null/undefined the function tries
// the `built-in-<id>` prefix as a second lookup.  The happy-path and
// "profile-not-found" cases in quorum.test.ts use a resolver that always
// returns null for both attempts; the case below exercises the branch where
// the primary id lookup fails but the prefixed id succeeds.
// ─────────────────────────────────────────────────────────────────────────────
describe("applyGeneralistSeatInvariant — built-in profile fallback", () => {
  const cfg: GeneralistSeatConfig = {
    enabled: true,
    profileId: "balanced",
    threshold: 2,
  };

  const candidates = [
    { profileId: "a", profile: { id: "a" } },
    { profileId: "b", profile: { id: "b" } },
  ];

  it("appends the generalist seat using the built-in-<id> fallback when primary id resolves to null", () => {
    // Primary lookup for "balanced" returns null; fallback "built-in-balanced" resolves.
    const resolveProfile = (id: string) =>
      id === "built-in-balanced"
        ? { id: "built-in-balanced", generalist: true }
        : null;

    const result = applyGeneralistSeatInvariant(candidates, cfg, resolveProfile);

    expect(result.appended).not.toBeNull();
    expect(result.appended!.profileId).toBe("balanced");
    expect(result.appended!.profile).toMatchObject({ id: "built-in-balanced", generalist: true });
    expect(result.candidates).toHaveLength(3);
    // Original array must not be mutated.
    expect(candidates).toHaveLength(2);
  });

  it("returns unchanged candidates when both primary and built-in-<id> lookups return null", () => {
    // Neither "balanced" nor "built-in-balanced" resolves.
    const result = applyGeneralistSeatInvariant(candidates, cfg, () => null);

    expect(result.appended).toBeNull();
    expect(result.candidates).toBe(candidates);
  });
});
