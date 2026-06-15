// synthesize — same-voter candidates are NEVER grouped (consensus needs ≥2 voters)
//
// synthesize.ts lines 272–286 seed groups greedily but skip any group that
// already contains a candidate from the same voter:
//
//   for (const g of groups) {
//     if (g.some((m) => m.voterId === c.voterId)) continue; // same-voter dup → keep separate
//     ...
//   }
//
// The governance invariant is: a single voter repeating themselves must NOT
// manufacture "consensus" — consensus must span at least two DISTINCT voters.
// Existing tests either give each voter a distinct topic or use genuinely
// different sentences, so the same-voter guard itself is never exercised: two
// textually IDENTICAL bullets from ONE voter (Dice = 1.0, well above the 0.45
// threshold) would merge into a single consensus finding if the guard were
// removed. This test pins that they stay as two separate "unique" findings.

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

function makeDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: "delib-same-voter-test",
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

describe("synthesize — a single voter cannot manufacture consensus", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-synth-samevoter-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("two identical bullets from ONE voter stay as two separate 'unique' findings", () => {
    // Both bullets share every meaningful token → Dice = 1.0 ≥ 0.45, so they
    // WOULD group if same-voter grouping were allowed. The guard forces them
    // apart: each lands in its own group of length 1 → category "unique".
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationaleHash: "sha256:" + "b".repeat(64),
        rationale: "- The auth logic is broken here\n- The auth logic is broken here",
      }),
    ];

    const out = synthesize({ deliberation, reviews });

    // Two candidates, no cross-voter pairing possible → two unique findings.
    expect(out.report.findings).toHaveLength(2);
    for (const f of out.report.findings) {
      expect(f.category).toBe("unique");
      expect(f.sourceVoterIds).toEqual(["v1"]);
    }
    // No finding is ever attributed to more than one voter.
    expect(out.report.findings.every((f) => f.sourceVoterIds.length === 1)).toBe(true);
  });

  it("an identical bullet from a SECOND voter does group into consensus (boundary contrast)", () => {
    // Same texts as above, but now split across two distinct voters. The
    // guard no longer applies, so the shared bullet groups into consensus
    // spanning both voters. This locks the guard's pivot on voterId alone.
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationaleHash: "sha256:" + "c".repeat(64),
        rationale: "- The auth logic is broken here",
      }),
      makeReview({
        voterId: "v2",
        bit: "CHANGES",
        rationaleHash: "sha256:" + "d".repeat(64),
        rationale: "- The auth logic is broken here",
      }),
    ];

    const out = synthesize({ deliberation, reviews });

    const consensus = out.report.findings.find((f) => f.category === "consensus");
    expect(consensus).toBeDefined();
    expect(consensus!.sourceVoterIds.sort()).toEqual(["v1", "v2"]);
  });
});
