// Behavioral tests for recordHumanNudge() — Slice C of run.ts.
//
// Covered behaviours:
//   • happy path: appends entry to humanNudges and clears awaitingNudge
//   • skip path: textHash may be null (user explicitly skipped)
//   • append-only: multiple nudges accumulate; earlier entries are preserved
//   • state guard: only allowed in CONVERGING / REVIEWING / SYNTHESIZING
//   • validation: afterRound must be >= 1; contributedBy must be "user"|"skip"
//   • expectedVersion guard: stale version throws StaleDeliberationError

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";

// ── test helper — directly seed a field into a persisted deliberation ────────
// transition() is missing apply-handlers for awaitingNudge / humanNudges, so
// we seed via the checkpoint layer to test the clearing behaviour.
function seedCheckpointField(id: string, fields: Record<string, unknown>) {
  const cp = checkpointStore.load(id) as any;
  if (!cp) throw new Error(`checkpoint not found: ${id}`);
  Object.assign(cp.deliberation, fields);
  checkpointStore.save(cp);
}

// ── helper — standard deliberation fixture ────────────────────────────────────

function makeConvergingDeliberation() {
  const d = run.propose({
    question: "Should we adopt async synthesis?",
    voters: [{ profileId: "a" }, { profileId: "b" }],
    promptSnapshot: "prompt text",
  });
  run.transition(d.id, "REVIEWING");
  run.transition(d.id, "SYNTHESIZING");
  run.transition(d.id, "CONVERGING", { currentRound: 1 });
  return run.loadDeliberation(d.id)!;
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("recordHumanNudge (Slice C)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-nudge-test-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ── happy path ──────────────────────────────────────────────────────────────

  it("appends a nudge entry with afterRound, contributedBy='user' and a non-empty ts", () => {
    const d = makeConvergingDeliberation();
    const before = Date.now();

    const after = run.recordHumanNudge(d.id, {
      afterRound: 1,
      textHash: "sha256:" + "a".repeat(64),
      contributedBy: "user",
    });

    expect(Array.isArray(after.humanNudges)).toBe(true);
    expect(after.humanNudges).toHaveLength(1);
    const entry = after.humanNudges![0];
    expect(entry.afterRound).toBe(1);
    expect(entry.textHash).toBe("sha256:" + "a".repeat(64));
    expect(entry.contributedBy).toBe("user");
    expect(typeof entry.ts).toBe("string");
    expect(entry.ts).not.toBe("");
    expect(Date.parse(entry.ts)).toBeGreaterThanOrEqual(before - 500);
  });

  it("clears awaitingNudge after recording so the orchestration loop can resume", () => {
    const base = makeConvergingDeliberation();

    // transition() validates awaitingNudge in PATCHABLE_FIELDS but has no
    // corresponding apply-handler — seed directly via the checkpoint layer to
    // simulate what the orchestration loop does when it pauses for human input.
    seedCheckpointField(base.id, {
      awaitingNudge: {
        afterRound: 1,
        promptText: "Any thoughts?",
        promptedAt: new Date().toISOString(),
      },
    });

    const loaded = run.loadDeliberation(base.id)!;
    expect(loaded.awaitingNudge).toBeDefined();

    const after = run.recordHumanNudge(loaded.id, {
      afterRound: 1,
      textHash: "sha256:" + "b".repeat(64),
      contributedBy: "user",
    });

    expect(after.awaitingNudge).toBeUndefined();
  });

  it("skip path: textHash may be null (user chose to provide no input)", () => {
    const d = makeConvergingDeliberation();

    const after = run.recordHumanNudge(d.id, {
      afterRound: 1,
      textHash: null,
      contributedBy: "skip",
    });

    expect(after.humanNudges).toHaveLength(1);
    expect(after.humanNudges![0].textHash).toBeNull();
    expect(after.humanNudges![0].contributedBy).toBe("skip");
  });

  it("append-only: multiple recordHumanNudge calls accumulate; earlier entries are preserved", () => {
    const d = makeConvergingDeliberation();

    run.recordHumanNudge(d.id, { afterRound: 1, textHash: "sha256:" + "1".repeat(64), contributedBy: "user" });
    run.recordHumanNudge(d.id, { afterRound: 1, textHash: null, contributedBy: "skip" });
    const final = run.recordHumanNudge(d.id, { afterRound: 2, textHash: "sha256:" + "3".repeat(64), contributedBy: "user" });

    expect(final.humanNudges).toHaveLength(3);
    expect(final.humanNudges![0].afterRound).toBe(1);
    expect(final.humanNudges![1].contributedBy).toBe("skip");
    expect(final.humanNudges![2].afterRound).toBe(2);
  });

  it("persists the nudge — reloading the deliberation from checkpoint returns the entry", () => {
    const d = makeConvergingDeliberation();

    run.recordHumanNudge(d.id, { afterRound: 1, textHash: "sha256:" + "c".repeat(64), contributedBy: "user" });

    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.humanNudges).toHaveLength(1);
    expect(reloaded.humanNudges![0].textHash).toBe("sha256:" + "c".repeat(64));
  });

  // ── state guard ─────────────────────────────────────────────────────────────

  it("rejects nudge in PROPOSED state", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    expect(() =>
      run.recordHumanNudge(d.id, { afterRound: 1, textHash: null, contributedBy: "skip" })
    ).toThrow(/cannot record nudge in state PROPOSED/);
  });

  it("rejects nudge in SETTLED state", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING");
    run.transition(d.id, "CONVERGING", { currentRound: 1 });
    run.transition(d.id, "SETTLED", { verdict: "approve" });
    expect(() =>
      run.recordHumanNudge(d.id, { afterRound: 1, textHash: null, contributedBy: "skip" })
    ).toThrow(/cannot record nudge in state SETTLED/);
  });

  it("rejects nudge in EXHAUSTED state", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "EXHAUSTED");
    expect(() =>
      run.recordHumanNudge(d.id, { afterRound: 1, textHash: null, contributedBy: "skip" })
    ).toThrow(/cannot record nudge in state EXHAUSTED/);
  });

  it("is allowed in REVIEWING state", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    const after = run.recordHumanNudge(d.id, { afterRound: 1, textHash: null, contributedBy: "skip" });
    expect(after.humanNudges).toHaveLength(1);
  });

  it("is allowed in SYNTHESIZING state", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING");
    const after = run.recordHumanNudge(d.id, { afterRound: 1, textHash: null, contributedBy: "skip" });
    expect(after.humanNudges).toHaveLength(1);
  });

  // ── input validation ────────────────────────────────────────────────────────

  it("rejects afterRound < 1", () => {
    const d = makeConvergingDeliberation();
    expect(() =>
      run.recordHumanNudge(d.id, { afterRound: 0, textHash: null, contributedBy: "skip" })
    ).toThrow(/afterRound must be >= 1/);
  });

  it("rejects invalid contributedBy value", () => {
    const d = makeConvergingDeliberation();
    expect(() =>
      run.recordHumanNudge(d.id, { afterRound: 1, textHash: null, contributedBy: "bot" as any })
    ).toThrow(/contributedBy must be "user" | "skip"/);
  });

  it("rejects null nudge argument", () => {
    const d = makeConvergingDeliberation();
    expect(() =>
      run.recordHumanNudge(d.id, null as any)
    ).toThrow(/nudge is required/);
  });

  // ── optimistic concurrency ──────────────────────────────────────────────────

  it("stale expectedVersion throws StaleDeliberationError without writing the nudge", () => {
    const d = makeConvergingDeliberation();

    expect(() =>
      run.recordHumanNudge(
        d.id,
        { afterRound: 1, textHash: null, contributedBy: "skip" },
        { expectedVersion: 9999 },
      )
    ).toThrow(run.StaleDeliberationError);

    // No nudge should have been written.
    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.humanNudges ?? []).toHaveLength(0);
  });
});
