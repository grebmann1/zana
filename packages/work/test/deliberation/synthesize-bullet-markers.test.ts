// Focused tests for the bullet-marker extraction variants in synthesize.ts.
//
// `extractBullets` recognises four marker styles via BULLET_RE:
//   /^\s*(?:[-*•]|\d+[.)])\s+/
//
// The existing synthesize.test.ts only exercises the `-` dash form.
// The existing synthesize-sentence-split.test.ts claims the others are
// "already well-exercised" — they are not.  This file exercises:
//   - `*` (asterisk)
//   - `•` (Unicode middle-dot bullet)
//   - `1.` / `2.` (numbered with period)
//   - `1)` / `2)` (numbered with parenthesis)
//
// All I/O stays in a per-test tmpdir; no real Claude; no shared state.

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

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: "delib-bm-test",
    state: "REVIEWING",
    question: "Ship it?",
    voters: [],
    rounds: 2,
    quorum: 1,
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

describe("synthesize — bullet-marker extraction variants", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-synth-bm-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ── asterisk bullets (* ) ─────────────────────────────────────────────────

  it("asterisk-bullet rationale produces one finding per bullet line", () => {
    const out = synthesize({
      deliberation: makeDeliberation(),
      reviews: [
        makeReview({
          rationale: "* Auth middleware is missing\n* Rate limiting not configured\n* Logging is absent",
        }),
      ],
    });

    expect(out.report.findings).toHaveLength(3);
    expect(out.report.findings[0].text).toBe("Auth middleware is missing");
    expect(out.report.findings[1].text).toBe("Rate limiting not configured");
    expect(out.report.findings[2].text).toBe("Logging is absent");
    // All unique — single voter.
    for (const f of out.report.findings) {
      expect(f.category).toBe("unique");
    }
  });

  // ── Unicode middle-dot bullet (•) ─────────────────────────────────────────

  it("unicode-bullet (•) rationale produces one finding per bullet line", () => {
    const out = synthesize({
      deliberation: makeDeliberation(),
      reviews: [
        makeReview({
          rationale: "• Critical: CSRF token missing\n• Should add input validation",
        }),
      ],
    });

    expect(out.report.findings).toHaveLength(2);
    expect(out.report.findings[0].text).toBe("Critical: CSRF token missing");
    expect(out.report.findings[1].text).toBe("Should add input validation");
  });

  // ── numbered bullets with period (1. 2.) ─────────────────────────────────

  it("numbered-period bullets (1. 2.) produce one finding per line", () => {
    const out = synthesize({
      deliberation: makeDeliberation(),
      reviews: [
        makeReview({
          rationale: "1. Fix the security vulnerability\n2. Add missing tests\n3. Update the docs",
        }),
      ],
    });

    expect(out.report.findings).toHaveLength(3);
    expect(out.report.findings[0].text).toBe("Fix the security vulnerability");
    expect(out.report.findings[1].text).toBe("Add missing tests");
    expect(out.report.findings[2].text).toBe("Update the docs");
  });

  // ── numbered bullets with parenthesis (1) 2)) ────────────────────────────

  it("numbered-paren bullets (1) 2)) produce one finding per line", () => {
    const out = synthesize({
      deliberation: makeDeliberation(),
      reviews: [
        makeReview({
          rationale: "1) Must fix injection flaw\n2) Consider adding rate limit",
        }),
      ],
    });

    expect(out.report.findings).toHaveLength(2);
    expect(out.report.findings[0].text).toBe("Must fix injection flaw");
    expect(out.report.findings[1].text).toBe("Consider adding rate limit");
  });

  // ── cross-voter consensus via numbered bullets ────────────────────────────

  it("two voters using numbered bullets still group into consensus when similar", () => {
    // Both voters flag the same security issue using numbered-period bullets.
    const out = synthesize({
      deliberation: makeDeliberation({ quorum: 2 }),
      reviews: [
        makeReview({
          voterId: "v1",
          bit: "CHANGES",
          rationaleHash: "sha256:" + "b".repeat(64),
          rationale: "1. Critical security exploit in auth flow\n2. Minor style nit",
        }),
        makeReview({
          voterId: "v2",
          bit: "CHANGES",
          rationaleHash: "sha256:" + "c".repeat(64),
          rationale: "1. Critical security vulnerability in authentication flow\n2. Minor naming nit",
        }),
      ],
    });

    // The two "security" bullets from v1 and v2 should be grouped as consensus;
    // the two "nit" bullets also overlap (minor + nit keywords).
    const consensus = out.report.findings.filter((f) => f.category === "consensus");
    expect(consensus.length).toBeGreaterThanOrEqual(1);
    // Consensus finding sources both voters.
    const securityFinding = consensus.find((f) => /security|auth/i.test(f.text));
    expect(securityFinding).toBeDefined();
    expect(securityFinding!.sourceVoterIds.sort()).toEqual(["v1", "v2"]);
  });
});
