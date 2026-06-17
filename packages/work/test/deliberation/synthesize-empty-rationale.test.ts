// Covers the untested combination of `rationale: ""` with `bit: "CHANGES"`.
//
// synthesize.ts keeps findings extraction and dissent recording on separate
// code paths:
//
//   findings path   (lines 256-268): extractBullets(r.rationale) → [] when
//                   rationale is empty → no candidates → no findings for that voter.
//
//   dissent path    (lines 322-332): iterates roundReviews, checks `r.bit ===
//                   "CHANGES"`, and unconditionally records the voter in
//                   dissentByVoter — REGARDLESS of whether they produced any findings.
//
// This means a CHANGES voter who provides an empty rationale must still appear
// in the dissent list (governance bar: minority vote is always audited), but
// must contribute zero findings to the report.
//
// No existing test exercises this invariant — all CHANGES reviews in the test
// suite carry non-empty rationale text.

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
    id: "delib-empty-rat",
    state: "REVIEWING",
    question: "Ship it?",
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
    bit: "CHANGES",
    rationaleHash: "sha256:" + "a".repeat(64),
    rationale: "some rationale",
    ...overrides,
  };
}

describe("synthesize — empty-string rationale", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-synth-emptyrat-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("CHANGES voter with empty rationale contributes no findings but still appears as a dissent", () => {
    // v1 votes CHANGES with an empty rationale (maybe they forgot to write one).
    // v2 votes APPROVE with a normal rationale.
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationale: "",
        rationaleHash: "sha256:" + "1".repeat(64),
      }),
      makeReview({
        voterId: "v2",
        bit: "APPROVE",
        rationale: "- Looks good to me overall",
        rationaleHash: "sha256:" + "2".repeat(64),
      }),
    ];

    const out = synthesize({ deliberation: makeDeliberation(), reviews });

    // v1 produced no candidates (empty string → extractBullets returns []) so
    // they must not appear as a sourceVoterId in any finding.
    for (const f of out.report.findings) {
      expect(f.sourceVoterIds).not.toContain("v1");
    }

    // The dissent list must still record v1 — empty rationale does NOT excuse
    // a CHANGES voter from the minority-report audit trail.
    expect(out.dissents).toHaveLength(1);
    expect(out.dissents[0].voterId).toBe("v1");
    expect(out.dissents[0].rationaleHash).toBe("sha256:" + "1".repeat(64));
    expect(out.report.dissentVoterIds).toEqual(["v1"]);
  });

  it("APPROVE voter with empty rationale contributes neither findings nor a dissent", () => {
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "APPROVE",
        rationale: "",
        rationaleHash: "sha256:" + "a".repeat(64),
      }),
    ];

    const out = synthesize({ deliberation: makeDeliberation(), reviews });

    // No findings, no dissents — an empty APPROVE is a no-op from the report perspective.
    expect(out.report.findings).toHaveLength(0);
    expect(out.dissents).toHaveLength(0);
    expect(out.report.tally).toEqual({ approve: 1, changes: 0 });
  });

  it("whitespace-only rationale is treated identically to empty — no findings, dissent recorded for CHANGES", () => {
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationale: "   \n  \t  ",
        rationaleHash: "sha256:" + "b".repeat(64),
      }),
    ];

    const out = synthesize({ deliberation: makeDeliberation(), reviews });

    expect(out.report.findings).toHaveLength(0);
    // Dissent still recorded: governance bar requires minority vote auditing.
    expect(out.dissents).toHaveLength(1);
    expect(out.dissents[0].voterId).toBe("v1");
  });
});
