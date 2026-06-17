// Targeted tests for the `verdictSource` provenance field set by recordOverride().
//
// The source docstring says:
//   "humanId carrying a 'judge:' prefix marks the override as having come from
//    the auto-judge path; everything else is treated as a human override."
//
// Existing run.test.ts only uses humanId="user:gr" (→ "human"), so the
// "judge" branch is never exercised. These tests cover:
//   1. humanId "judge:<profileId>" → verdictSource = "judge"
//   2. Any other humanId           → verdictSource = "human"
//   3. Boundary: humanId = "judge" (no colon) → still "human" (doesn't startsWith "judge:")
//
// No real Claude. No real network. Pure local checkpoint I/O.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";

// Helper — advance a deliberation to ESCALATED so recordOverride is legal.
function proposeAndEscalate(question = "Should we ship?") {
  const d = run.propose({
    question,
    voters: [{ profileId: "reviewer-a" }],
    promptSnapshot: "snapshot-text",
  });
  run.transition(d.id, "REVIEWING");
  run.transition(d.id, "ESCALATED", { escalationReason: "cap_exhausted" });
  return d;
}

describe("recordOverride — verdictSource provenance (run.ts)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-override-src-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it('humanId starting with "judge:" sets verdictSource to "judge"', () => {
    const d = proposeAndEscalate();
    const after = run.recordOverride(d.id, {
      humanId: "judge:architect",
      decision: "approve",
      reasonHash: "sha256:" + "a".repeat(64),
      ts: new Date().toISOString(),
    });
    expect(after.verdictSource).toBe("judge");
  });

  it('humanId NOT starting with "judge:" sets verdictSource to "human"', () => {
    const d = proposeAndEscalate();
    const after = run.recordOverride(d.id, {
      humanId: "user:alice",
      decision: "reject",
      reasonHash: "sha256:" + "b".repeat(64),
      ts: new Date().toISOString(),
    });
    expect(after.verdictSource).toBe("human");
  });

  it('humanId exactly "judge" (no colon) is treated as "human" — does not satisfy startsWith("judge:")', () => {
    const d = proposeAndEscalate();
    const after = run.recordOverride(d.id, {
      humanId: "judge",
      decision: "rework",
      reasonHash: "sha256:" + "c".repeat(64),
      ts: new Date().toISOString(),
    });
    expect(after.verdictSource).toBe("human");
  });

  it("verdictSource is persisted — loadDeliberation returns the same value", () => {
    const d = proposeAndEscalate();
    run.recordOverride(d.id, {
      humanId: "judge:security-reviewer",
      decision: "approve",
      reasonHash: "sha256:" + "d".repeat(64),
      ts: new Date().toISOString(),
    });
    const reloaded = run.loadDeliberation(d.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.verdictSource).toBe("judge");
  });
});
