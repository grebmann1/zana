// Focused tests for the sentence-split extraction path in synthesize.ts.
//
// The `extractBullets` function (internal to synthesize.ts) has three paths:
//   1. Bullet markers (-, *, •, N., N)) → already well-exercised by synthesize.test.ts
//   2. Sentence-terminator split (". " / "! " / "? ") → UNTESTED until now
//   3. Entire rationale as one finding (fallback)              → untested edge
//
// This file exercises paths 2 and 3 via the `synthesize` public API, plus
// the zero-reviews edge case that was also missing.  All I/O stays in a
// per-test tmpdir; no real Claude; clocks are not used.

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

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: "delib-ss-test",
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
    rationaleHash: "sha256:" + "f".repeat(64),
    rationale: "placeholder",
    ...overrides,
  };
}

// ── fixture ──────────────────────────────────────────────────────────────────

describe("synthesize — sentence-split and edge-case paths", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-synth-ss-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ── path 2: sentence-terminator split ────────────────────────────────────

  it("multi-sentence paragraph rationale produces one finding per sentence", () => {
    // No bullet markers → extractBullets takes the sentence-split branch.
    // "The auth is broken. The config is missing. The test coverage is low."
    // splits on ". " → three candidates: three unique findings (one voter).
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationale: "The auth is broken. The config is missing. The test coverage is low.",
      }),
    ];

    const out = synthesize({ deliberation, reviews });

    // Three sentences → three finding candidates → three unique findings.
    expect(out.report.findings).toHaveLength(3);
    // All are unique (single voter — no cross-voter grouping possible).
    for (const f of out.report.findings) {
      expect(f.category).toBe("unique");
      expect(f.sourceVoterIds).toEqual(["v1"]);
    }
    // Trailing punctuation stripped: "The auth is broken" (no trailing dot).
    expect(out.report.findings[0].text).toBe("The auth is broken");
  });

  it("sentence split on '?' and '!' terminators also extracts multiple findings", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationale: "Is the auth secure? It must be fixed! Consider adding tests.",
      }),
    ];

    const out = synthesize({ deliberation, reviews });

    // Three sentences separated by "? " and "! " and ". " → three findings.
    expect(out.report.findings).toHaveLength(3);
  });

  // ── path 3: whole rationale as one finding (no terminators, no bullets) ──

  it("single-word or no-punctuation rationale yields exactly one finding", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({ voterId: "v1", bit: "APPROVE", rationale: "LGTM" }),
    ];

    const out = synthesize({ deliberation, reviews });

    // "LGTM" has no bullet markers and no sentence terminators → falls back
    // to the whole string as one candidate.
    expect(out.report.findings).toHaveLength(1);
    expect(out.report.findings[0].text).toBe("LGTM");
    expect(out.report.findings[0].category).toBe("unique");
  });

  // ── zero-reviews edge case ────────────────────────────────────────────────

  it("empty reviews array produces an empty report with zero tally", () => {
    const deliberation = makeDeliberation();

    const out = synthesize({ deliberation, reviews: [] });

    expect(out.report.findings).toHaveLength(0);
    expect(out.report.tally).toEqual({ approve: 0, changes: 0 });
    expect(out.dissents).toHaveLength(0);
    // reportHash must still be a sha256 string (content-addressed even for empty).
    expect(out.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
