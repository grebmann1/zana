// Focused tests for the `recordDissent` state-guard logic in run.ts (T5c).
//
// The gate (run.ts ~454-458):
//
//   const isSettledClean = s === "SETTLED" && d.override === undefined;
//   if (s === "PROPOSED" || s === "EXHAUSTED" || isSettledClean) {
//     throw new Error(`recordDissent: cannot record dissent in state ${s}`);
//   }
//
// Three paths that the main run.test.ts leaves untested:
//   A. EXHAUSTED             → must throw (same guard, no test exists)
//   B. SETTLED without override → must throw (isSettledClean = true)
//   C. SETTLED WITH override    → must NOT throw (isSettledClean = false)
//      This is the key positive case: an operator overriding a SETTLED
//      deliberation is allowed to attach post-hoc dissent context.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";
import type { Dissent } from "@zana-ai/work/src/deliberation/types.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDissent(): Dissent {
  return {
    voterId: "agent-x",
    profileId: "code-reviewer",
    round: 1,
    rationaleHash: "sha256:" + "d".repeat(64),
    ts: "",
  };
}

function makeOverride() {
  return {
    humanId: "operator-1",
    decision: "approve" as const,
    reasonHash: "sha256:" + "e".repeat(64),
    ts: new Date().toISOString(),
  };
}

// ── fixture ───────────────────────────────────────────────────────────────────

describe("recordDissent — EXHAUSTED and SETTLED state guards (T5c)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-dissent-guards-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ── Path A — EXHAUSTED ─────────────────────────────────────────────────────

  it("recordDissent throws when deliberation is EXHAUSTED", () => {
    const d = run.propose({
      question: "Can we proceed?",
      voters: [{ profileId: "a" }],
      promptSnapshot: "snapshot",
    });
    // Cancel from PROPOSED → EXHAUSTED
    run.transition(d.id, "EXHAUSTED");

    expect(() => run.recordDissent(d.id, makeDissent())).toThrow(
      /cannot record dissent in state EXHAUSTED/,
    );
  });

  // ── Path B — SETTLED without override (isSettledClean = true) ─────────────

  it("recordDissent throws when deliberation is SETTLED and no override is present", () => {
    const d = run.propose({
      question: "Should we ship?",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "snapshot",
    });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING", { synthesisHash: "sha256:" + "0".repeat(64) });
    run.transition(d.id, "CONVERGING", { currentRound: 1 });
    run.transition(d.id, "SETTLED", { verdict: "approve" });

    // No override recorded → isSettledClean = true → must throw.
    expect(() => run.recordDissent(d.id, makeDissent())).toThrow(
      /cannot record dissent in state SETTLED/,
    );
  });

  // ── Path C — SETTLED WITH override (isSettledClean = false) ───────────────

  it("recordDissent is allowed when deliberation is SETTLED and an override is already in place", () => {
    // ESCALATED → override → SETTLED. This models the scenario where an
    // operator overrides an escalated deliberation and also wants to attach
    // a post-hoc dissent (e.g. minority report from a late voter).
    const d = run.propose({
      question: "Should we refactor?",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "snapshot",
    });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "ESCALATED", { escalationReason: "explicit" });

    // Record override → now d.override is defined, d.state = "SETTLED".
    run.recordOverride(d.id, makeOverride());

    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.state).toBe("SETTLED");
    expect(reloaded.override).toBeDefined();

    // isSettledClean = false (override present) → recordDissent must succeed.
    const after = run.recordDissent(d.id, makeDissent());
    expect(after.dissent).toHaveLength(1);
    expect(after.dissent[0].voterId).toBe("agent-x");
    // recordDissent stamps ts for blank inputs.
    expect(typeof after.dissent[0].ts).toBe("string");
    expect(after.dissent[0].ts).not.toBe("");
  });
});
