// synthesize — a voter with multiple CHANGES reviews yields ONE dissent (latest wins)
//
// synthesize.ts lines 322–333 record dissent through a Map keyed by voterId:
//
//   const dissentByVoter = new Map<string, Dissent>();
//   for (const r of roundReviews) {
//     if (r.bit !== "CHANGES") continue;
//     dissentByVoter.set(r.voterId, { voterId, profileId, round, rationaleHash, ts: "" });
//   }
//   const dissents = Array.from(dissentByVoter.values());
//
// The documented invariant (lines 315–317): "if a voter has multiple reviews in
// this round (shouldn't happen but guard anyway), record the latest one."
// Because the Map keys on voterId, a second CHANGES review from the same voter
// OVERWRITES the first — so exactly one Dissent survives, carrying the fields of
// the LAST review in input order. Existing synthesize tests never feed two
// CHANGES reviews from one voter in the same round, so this dedup/last-wins
// behavior is unexercised. This test pins it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import { synthesize } from "@zana-ai/work/src/deliberation/synthesize.ts";
import type { VoterReview } from "@zana-ai/work/src/deliberation/synthesize.ts";
import type { Deliberation } from "@zana-ai/work/src/deliberation/types.ts";

function makeDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: "delib-dissent-dedup-test",
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

describe("synthesize — duplicate CHANGES reviews from one voter dedupe to the latest dissent", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-synth-dissent-dedup-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("two CHANGES reviews from the same voter produce a single dissent carrying the LAST review's fields", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        profileId: "first-profile",
        bit: "CHANGES",
        rationaleHash: "sha256:" + "1".repeat(64),
        rationale: "- early concern about caching",
      }),
      makeReview({
        voterId: "v1",
        profileId: "second-profile",
        bit: "CHANGES",
        rationaleHash: "sha256:" + "2".repeat(64),
        rationale: "- revised concern about caching",
      }),
    ];

    const out = synthesize({ deliberation, reviews });

    // Exactly one dissent — the Map keyed on voterId collapses the duplicate.
    expect(out.dissents).toHaveLength(1);
    const dissent = out.dissents[0];
    expect(dissent.voterId).toBe("v1");

    // Last-write-wins: the surviving dissent carries the SECOND review's fields.
    expect(dissent.profileId).toBe("second-profile");
    expect(dissent.rationaleHash).toBe("sha256:" + "2".repeat(64));
    expect(dissent.round).toBe(1);
    // ts is stamped by the persistence boundary, not the reducer (T7-FU-a).
    expect(dissent.ts).toBe("");

    // The report's dissentVoterIds mirrors the deduped list — no duplicate id.
    expect(out.report.dissentVoterIds).toEqual(["v1"]);
    expect(out.report.tally).toEqual({ approve: 0, changes: 2 });
  });

  it("distinct CHANGES voters are NOT deduped — each yields its own dissent (boundary contrast)", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({ voterId: "v1", bit: "CHANGES", rationaleHash: "sha256:" + "a".repeat(64) }),
      makeReview({ voterId: "v2", bit: "CHANGES", rationaleHash: "sha256:" + "b".repeat(64) }),
    ];

    const out = synthesize({ deliberation, reviews });

    expect(out.dissents).toHaveLength(2);
    expect(out.report.dissentVoterIds.sort()).toEqual(["v1", "v2"]);
  });
});
