// synthesize — "all-negated group = consensus" branch
//
// synthesize.ts lines 298–307:
//
//   if (g.length >= 2) {
//     const negCount = g.filter((m) => m.negated).length;
//     if (negCount > 0 && negCount < g.length) {
//       category = "disagreement";    // ← MIXED negation
//     } else {
//       category = "consensus";       // ← ALL or NONE negated
//     }
//   }
//
// Every existing test exercises one of two sub-cases:
//   • none negated → consensus  (e.g. both voters flag the same bug)
//   • mixed negated → disagreement  (e.g. "broken" vs "fine")
//
// The third sub-case — ALL members negated, negCount === g.length — also
// produces "consensus" (two voters mutually agreeing the thing is fine).
// This branch was never reached by any test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import { synthesize } from "@zana-ai/work/src/deliberation/synthesize.ts";
import type { VoterReview } from "@zana-ai/work/src/deliberation/synthesize.ts";
import type { Deliberation } from "@zana-ai/work/src/deliberation/types.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: "delib-allneg-test",
    state: "REVIEWING",
    question: "Should we ship this?",
    voters: [],
    rounds: 2,
    quorum: 2,
    mode: "synthesis",
    promptSnapshotHash: "sha256:" + "0".repeat(64),
    currentRound: 1,
    votes: [],
    dissent: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0,
    ...overrides,
  };
}

function makeReview(overrides: Partial<VoterReview> = {}): VoterReview {
  return {
    voterId: "voter-1",
    profileId: "code-reviewer",
    modelId: "claude-opus",
    round: 1,
    bit: "APPROVE",
    rationaleHash: "sha256:" + "a".repeat(64),
    rationale: "placeholder",
    ...overrides,
  };
}

// ── fixture ───────────────────────────────────────────────────────────────────

describe("synthesize — all-negated group is classified as consensus, not disagreement", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-synth-allneg-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // When every member of a grouped pair uses negation ("not broken" + "not
  // broken") the condition `negCount > 0 && negCount < g.length` is false
  // (negCount === g.length), so the category must be "consensus" not
  // "disagreement". Before this test existed, the branch was unreachable.
  it("two voters both using negated language about the same topic group as 'consensus'", () => {
    // Both rationales contain "not" (triggering NEGATION_RE) and share enough
    // tokens ("auth", "logic", "broken" / "authentication", "logic", "broken")
    // for Dice similarity to exceed the default 0.45 threshold, so they group.
    // Expected: negCount === 2 === g.length → "consensus", not "disagreement".
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "APPROVE",
        rationale: "- The auth logic is not broken here",
        rationaleHash: "sha256:" + "b".repeat(64),
      }),
      makeReview({
        voterId: "v2",
        bit: "APPROVE",
        rationale: "- The authentication logic is not broken here",
        rationaleHash: "sha256:" + "c".repeat(64),
      }),
    ];

    const out = synthesize({ deliberation, reviews });

    // Both bullets must be grouped (Dice on shared meaningful tokens is ≥ 0.45).
    // The grouped finding must carry category="consensus", not "disagreement".
    const grouped = out.report.findings.find((f) => f.sourceVoterIds.length === 2);
    expect(grouped).toBeDefined();
    expect(grouped!.category).toBe("consensus");
    expect(grouped!.sourceVoterIds.sort()).toEqual(["v1", "v2"]);
  });

  // Contrast: ONE voter negates, the other doesn't → "disagreement".
  // This documents the boundary so the two cases can't silently swap.
  it("one voter negates, other does not → disagreement (boundary contrast)", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationale: "- The auth logic is broken",
        rationaleHash: "sha256:" + "d".repeat(64),
      }),
      makeReview({
        voterId: "v2",
        bit: "APPROVE",
        // "fine" triggers NEGATION_RE; "broken" shared token ensures grouping.
        rationale: "- The auth logic is fine",
        rationaleHash: "sha256:" + "e".repeat(64),
      }),
    ];

    const out = synthesize({ deliberation, reviews });

    const grouped = out.report.findings.find((f) => f.sourceVoterIds.length === 2);
    expect(grouped).toBeDefined();
    expect(grouped!.category).toBe("disagreement");
  });
});
