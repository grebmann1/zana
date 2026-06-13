// Focused tests for out-of-range similarityThreshold fallback guards in synthesize.ts.
//
// synthesize.ts has two threshold guards (lines ~244-247):
//
//   const configuredThreshold = (() => {
//     const v = getRuntimeConfig().synthesisSimilarityThreshold;
//     return typeof v === "number" && v >= 0 && v <= 1 ? v : 0.45; // ← guard 1
//   })();
//   const threshold =
//     typeof opts?.similarityThreshold === "number" &&
//     opts.similarityThreshold >= 0 && opts.similarityThreshold <= 1
//       ? opts.similarityThreshold
//       : configuredThreshold; // ← guard 2 falls back to configuredThreshold
//
// No existing test exercises either guard's "out-of-range → fallback" branch.
//
// Strategy: use two voters whose candidates share enough tokens to reach
// Dice ≥ 0.45 (they group as "consensus" at the default threshold), but
// Dice < 1.5 (never group if an out-of-range threshold were naively used).
// If the guards are working, the out-of-range input is ignored and the
// candidates still group — the test fails only if the guard is broken.

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
import {
  setRuntimeConfig,
  resetRuntimeConfig,
} from "@zana-ai/work/src/deliberation/runtime-config.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: "delib-threshold",
    state: "REVIEWING",
    question: "Should we ship X?",
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
    voterId: "v1",
    profileId: "system-architect",
    modelId: "claude-opus",
    round: 1,
    bit: "CHANGES",
    rationaleHash: "sha256:" + "1".repeat(64),
    rationale: "Some rationale text.",
    ...overrides,
  };
}

// Two rationale strings whose extracted candidates have Dice ≈ 0.545 at the
// word level (after stop-word removal).  They group at threshold ≤ 0.545 but
// not at threshold > 0.545.  The default fallback (0.45) must group them;
// a naively-applied out-of-range threshold (1.5 or -0.5) must not override
// that fallback.
//
// tokens("authentication token missing from request")
//   → {authentication, token, missing, from, request}  (5)
// tokens("missing authentication token causes security issue")
//   → {missing, authentication, token, causes, security, issue}  (6)
// intersection = {missing, authentication, token}  (3)
// Dice = 2*3 / (5+6) = 6/11 ≈ 0.545  >  0.45  ✓
const REVIEW_A_RATIONALE = "- authentication token missing from request";
const REVIEW_B_RATIONALE = "- missing authentication token causes security issue";

// ── suite ────────────────────────────────────────────────────────────────────

describe("synthesize — out-of-range similarityThreshold fallback", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-synth-thr-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
    resetRuntimeConfig();
  });

  afterEach(() => {
    resetRuntimeConfig();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("opts.similarityThreshold > 1 falls back to default 0.45 → candidates still group", () => {
    // If 1.5 were used naively, Dice(0.545) < 1.5 → candidates never group.
    // The guard must reject 1.5 and fall back to 0.45, so they DO group.
    const out = synthesize(
      {
        deliberation: makeDeliberation(),
        reviews: [
          makeReview({ voterId: "v1", rationale: REVIEW_A_RATIONALE }),
          makeReview({ voterId: "v2", rationale: REVIEW_B_RATIONALE }),
        ],
      },
      { similarityThreshold: 1.5 },
    );
    expect(out.report.findings.some((f) => f.category === "consensus")).toBe(true);
  });

  it("opts.similarityThreshold < 0 falls back to default 0.45 → candidates still group", () => {
    // A negative threshold is meaningless; the guard must ignore it.
    const out = synthesize(
      {
        deliberation: makeDeliberation(),
        reviews: [
          makeReview({ voterId: "v1", rationale: REVIEW_A_RATIONALE }),
          makeReview({ voterId: "v2", rationale: REVIEW_B_RATIONALE }),
        ],
      },
      { similarityThreshold: -0.5 },
    );
    expect(out.report.findings.some((f) => f.category === "consensus")).toBe(true);
  });

  it("getRuntimeConfig().synthesisSimilarityThreshold > 1 falls back to 0.45", () => {
    // Inject an out-of-range config value. The inner guard must clamp it to 0.45
    // so candidates whose Dice ≈ 0.545 still group as "consensus".
    setRuntimeConfig({ synthesisSimilarityThreshold: 2 });
    const out = synthesize({
      deliberation: makeDeliberation(),
      reviews: [
        makeReview({ voterId: "v1", rationale: REVIEW_A_RATIONALE }),
        makeReview({ voterId: "v2", rationale: REVIEW_B_RATIONALE }),
      ],
    });
    expect(out.report.findings.some((f) => f.category === "consensus")).toBe(true);
  });
});
