// synthesize — bullets that tokenize to an EMPTY token set never group
//
// extractBullets() keeps any non-empty bullet text as a finding candidate, but
// tokenize() (synthesize.ts lines 149–156) drops stop-words and 1-char tokens.
// A bullet made entirely of stop-words therefore yields a real candidate whose
// token Set is empty. When two such candidates are compared, dice() hits its
//
//   if (a.size === 0 && b.size === 0) return 0;   // synthesize.ts line 159
//
// guard and returns 0 — below any valid threshold — so the candidates must NOT
// merge into consensus even though their text is byte-for-byte identical.
//
// Existing coverage gap: the "empty rationale" tests exercise rationales that
// produce ZERO candidates (extractBullets → []), and the same-voter test uses
// high-Dice meaningful tokens. Neither reaches the empty-empty dice branch with
// a surviving finding. This test pins that branch and the resulting behavior:
// identical all-stop-word bullets from two DISTINCT voters stay "unique".

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
    id: "delib-empty-tokens-test",
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
    bit: "CHANGES",
    rationaleHash: "sha256:" + "a".repeat(64),
    rationale: "placeholder",
    ...overrides,
  };
}

describe("synthesize — all-stop-word bullets (empty token set) never group", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-synth-emptytok-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("identical all-stop-word bullets from two voters stay 'unique' (dice empty/empty = 0)", () => {
    // "the and or with this that" → every token is a stop-word → tokenize() → ∅.
    // Two DISTINCT voters, so the same-voter guard does NOT apply; the ONLY
    // reason they fail to group is dice({},{}) === 0 < threshold. Pin that.
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        rationaleHash: "sha256:" + "b".repeat(64),
        rationale: "- the and or with this that",
      }),
      makeReview({
        voterId: "v2",
        rationaleHash: "sha256:" + "c".repeat(64),
        rationale: "- the and or with this that",
      }),
    ];

    const out = synthesize({ deliberation, reviews });

    // Each empty-token candidate seeds its own group → two unique findings.
    expect(out.report.findings).toHaveLength(2);
    for (const f of out.report.findings) {
      expect(f.category).toBe("unique");
      expect(f.sourceVoterIds).toHaveLength(1);
    }
    // No consensus is ever manufactured from token-less text.
    expect(out.report.findings.some((f) => f.category === "consensus")).toBe(false);
    // Both CHANGES voters still surface as dissents, and the report stays
    // content-addressable despite the degenerate tokens.
    expect(out.dissents.map((d) => d.voterId).sort()).toEqual(["v1", "v2"]);
    expect(out.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
