// Focused coverage for the untested keyword branches in defaultSeverityHeuristic
// (synthesize.ts lines 75–91).
//
// Existing tests cover: blocker, critical, must, security, csrf, should,
// missing, broken, consider, minor.  The following keywords have no direct
// severity-assertion in any test:
//   CRITICAL: xss, regression-adjacent words, exploit (severity only)
//   MAJOR:    regression, incorrect, important
//   MINOR:    prefer, nice, could
//   NIT:      fallback when no keyword matches
//
// We exercise via the public `synthesize()` API with a single-voter review so
// the text ends up as a `unique` finding whose `severity` we can assert
// directly.  No real Claude, no real network — just tmpdir + artifact store.

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

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDeliberation(): Deliberation {
  return {
    id: "delib-sev-test",
    state: "REVIEWING",
    question: "Ship it?",
    voters: [],
    rounds: 1,
    quorum: 1,
    mode: "synthesis",
    promptSnapshotHash: "sha256:" + "0".repeat(64),
    currentRound: 1,
    votes: [],
    dissent: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0,
  };
}

function severityOf(rationale: string): string {
  const delib = makeDeliberation();
  const review: VoterReview = {
    voterId: "v1",
    profileId: "reviewer",
    modelId: "claude-opus",
    round: 1,
    bit: "CHANGES",
    rationaleHash: "sha256:" + "a".repeat(64),
    rationale,
  };
  const out = synthesize({ deliberation: delib, reviews: [review] });
  // Single bullet → one unique finding.
  return out.report.findings[0]?.severity ?? "NONE";
}

// ── fixture ───────────────────────────────────────────────────────────────────

describe("defaultSeverityHeuristic — untested keyword branches", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-sev-kw-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ── CRITICAL keywords ──────────────────────────────────────────────────────

  it("'xss' classifies as CRITICAL", () => {
    expect(severityOf("- Reflected XSS in the search param")).toBe("CRITICAL");
  });

  it("'injection' classifies as CRITICAL", () => {
    expect(severityOf("- SQL injection risk in the query builder")).toBe("CRITICAL");
  });

  it("'exploit' classifies as CRITICAL", () => {
    expect(severityOf("- There is a known exploit for this library version")).toBe("CRITICAL");
  });

  // ── MAJOR keywords ─────────────────────────────────────────────────────────

  it("'regression' classifies as MAJOR", () => {
    expect(severityOf("- This change introduces a regression in the auth flow")).toBe("MAJOR");
  });

  it("'incorrect' classifies as MAJOR", () => {
    expect(severityOf("- The error message text is incorrect")).toBe("MAJOR");
  });

  it("'important' classifies as MAJOR", () => {
    expect(severityOf("- It is important to validate the input here")).toBe("MAJOR");
  });

  // ── MINOR keywords ─────────────────────────────────────────────────────────

  it("'prefer' classifies as MINOR", () => {
    expect(severityOf("- I prefer early-return style here")).toBe("MINOR");
  });

  it("'nice' classifies as MINOR", () => {
    expect(severityOf("- It would be nice to add a comment explaining this")).toBe("MINOR");
  });

  it("'could' classifies as MINOR", () => {
    expect(severityOf("- This could be extracted into a helper")).toBe("MINOR");
  });

  // ── NIT fallback ──────────────────────────────────────────────────────────

  it("text with no matching keyword falls back to NIT", () => {
    expect(severityOf("- The variable name is a bit long")).toBe("NIT");
    expect(severityOf("- Looks good overall")).toBe("NIT");
  });
});
