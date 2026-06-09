// Focused tests for the four early-exit branches of applyGeneralistSeatInvariant
// in packages/work/src/deliberation/quorum.ts.
//
// The existing quorum-pure-fns.test.ts covers the built-in-<id> fallback path
// (line 156) and the "both resolvers return null" path (line 158).  These four
// branches — disabled, below-threshold, generalist-flag-present, and
// profileId-already-in-list — are untested and represent real governance
// invariants: silently skipping them would let the generalist seat get injected
// into configurations where it should not appear.
import { describe, it, expect } from "vitest";
import { applyGeneralistSeatInvariant } from "@zana-ai/work/src/deliberation/quorum.ts";
import type {
  GeneralistSeatConfig,
  VoterCandidate,
} from "@zana-ai/work/src/deliberation/quorum.ts";

// Stub resolver — should never be called on the early-exit paths.
const neverCalled = (_id: string): any => {
  throw new Error("resolveProfile should not be called on this path");
};

const alwaysReturnsProfile = (id: string) => ({ id, generalist: true });

const BASE_CFG: GeneralistSeatConfig = {
  enabled: true,
  profileId: "researcher",
  threshold: 2,
};

const TWO_CANDIDATES: VoterCandidate[] = [
  { profileId: "coder", profile: { id: "coder" } },
  { profileId: "reviewer", profile: { id: "reviewer" } },
];

describe("applyGeneralistSeatInvariant — early-exit branches", () => {
  it("returns candidates unchanged when cfg.enabled is false", () => {
    const cfg: GeneralistSeatConfig = { ...BASE_CFG, enabled: false };
    const result = applyGeneralistSeatInvariant(TWO_CANDIDATES, cfg, neverCalled);
    expect(result.appended).toBeNull();
    expect(result.candidates).toBe(TWO_CANDIDATES); // referential equality — no copy
  });

  it("returns candidates unchanged when candidate count is below threshold", () => {
    // Only 1 candidate, threshold is 2 — generalist seat should NOT be added.
    const onlyOne: VoterCandidate[] = [{ profileId: "coder", profile: { id: "coder" } }];
    const result = applyGeneralistSeatInvariant(onlyOne, BASE_CFG, neverCalled);
    expect(result.appended).toBeNull();
    expect(result.candidates).toBe(onlyOne);
  });

  it("returns candidates unchanged when an existing candidate carries generalist=true", () => {
    // One of the candidates is already a generalist — invariant is satisfied, skip.
    const withGeneralist: VoterCandidate[] = [
      { profileId: "coder", profile: { id: "coder" } },
      { profileId: "balanced", profile: { id: "balanced", generalist: true } },
    ];
    const result = applyGeneralistSeatInvariant(
      withGeneralist,
      BASE_CFG,
      neverCalled,
    );
    expect(result.appended).toBeNull();
    expect(result.candidates).toBe(withGeneralist);
  });

  it("returns candidates unchanged when the configured profileId is already present (even without the flag)", () => {
    // Configured generalist is profileId "researcher"; a candidate with that
    // id is already in the list.  Should not double-add.
    const alreadyPresent: VoterCandidate[] = [
      { profileId: "coder", profile: { id: "coder" } },
      { profileId: "researcher", profile: { id: "researcher" } }, // no generalist flag
    ];
    const result = applyGeneralistSeatInvariant(
      alreadyPresent,
      BASE_CFG,
      alwaysReturnsProfile,
    );
    expect(result.appended).toBeNull();
    expect(result.candidates).toBe(alreadyPresent);
    expect(result.candidates).toHaveLength(2); // no third entry added
  });
});
