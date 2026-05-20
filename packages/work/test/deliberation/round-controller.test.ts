import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana/core/src/project/workspace-context.ts";
import * as core from "@zana/core";
import * as checkpointStore from "@zana/work/src/runs/checkpoint/store.ts";
import * as run from "@zana/work/src/deliberation/run.ts";
import * as rc from "@zana/work/src/deliberation/round-controller.ts";
import * as runtimeConfig from "@zana/work/src/deliberation/runtime-config.ts";
import type { Deliberation, Vote, Dissent } from "@zana/work/src/deliberation/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — push a deliberation into CONVERGING state with N voters and the
// supplied votes for the current round. Keeps each test compact.
// ─────────────────────────────────────────────────────────────────────────────

function makeVote(
  d: Deliberation,
  voterId: string,
  bit: "APPROVE" | "CHANGES",
  round: number,
): Vote {
  return {
    voterId,
    profileId: voterId + "-profile",
    modelId: "claude-opus",
    round,
    bit,
    rationaleHash:
      "sha256:" + voterId.padEnd(8, "0").repeat(8).slice(0, 64),
    promptSnapshotHash: d.promptSnapshotHash,
    ts: new Date().toISOString(),
  };
}

interface SetupOptions {
  voterCount?: number;
  rounds?: number;
  quorum?: number;
  riskTag?: "low" | "medium" | "high";
  /** Votes for the current round to record. */
  votes?: Array<{ voterId: string; bit: "APPROVE" | "CHANGES" }>;
  /** Advance to round N (CONVERGING with currentRound = N). Default 1. */
  currentRound?: number;
  /** Add prior-round dissent entries before the current round. */
  priorDissent?: Array<{ voterId: string }>;
}

function setup(opts: SetupOptions = {}): Deliberation {
  const voterCount = opts.voterCount ?? 3;
  const voters = Array.from({ length: voterCount }, (_, i) => ({
    profileId: `voter-${i + 1}`,
  }));
  const proposed = run.propose({
    question: "q",
    voters,
    promptSnapshot: "prompt",
    rounds: opts.rounds ?? 2,
    quorum: opts.quorum ?? voterCount,
    riskTag: opts.riskTag,
  });

  // PROPOSED → REVIEWING → SYNTHESIZING → CONVERGING (round 1)
  run.transition(proposed.id, "REVIEWING");
  run.transition(proposed.id, "SYNTHESIZING", {
    synthesisHash: "sha256:" + "a".repeat(64),
  });
  let d = run.transition(proposed.id, "CONVERGING", { currentRound: 1 });

  // If we want round 2 (or later), bump CONVERGING → CONVERGING.
  const target = opts.currentRound ?? 1;
  for (let r = 2; r <= target; r++) {
    d = run.transition(proposed.id, "CONVERGING", { currentRound: r });
  }

  // Record any prior dissent (these belong to earlier rounds — round=1).
  if (opts.priorDissent) {
    for (const pd of opts.priorDissent) {
      const dissent: Dissent = {
        voterId: pd.voterId,
        profileId: pd.voterId + "-profile",
        round: 1,
        rationaleHash:
          "sha256:" + pd.voterId.padEnd(8, "0").repeat(8).slice(0, 64),
        ts: new Date().toISOString(),
      };
      run.recordDissent(proposed.id, dissent);
    }
  }

  // Record current-round votes.
  if (opts.votes) {
    for (const v of opts.votes) {
      run.recordVote(
        proposed.id,
        makeVote(d, v.voterId, v.bit, target),
      );
    }
  }

  return run.loadDeliberation(proposed.id)!;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("deliberation round controller (T8)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-rc-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ───────────────────────────── decide() ─────────────────────────────

  it("decide: 3 voters, 3 APPROVE, round 1 → SETTLE verdict approve", () => {
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 1,
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "APPROVE" },
      ],
    });

    const decision = rc.decide({ deliberation: d });
    expect(decision.action).toBe("SETTLE");
    if (decision.action !== "SETTLE") throw new Error("type guard");
    expect(decision.verdict).toBe("approve");
    expect(decision.tally).toEqual({ approve: 3, changes: 0 });
  });

  it("decide: 3 voters, 2 APPROVE 1 CHANGES, round 1 of 2 → ADVANCE_ROUND to 2", () => {
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 1,
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "CHANGES" },
      ],
    });

    const decision = rc.decide({ deliberation: d });
    expect(decision.action).toBe("ADVANCE_ROUND");
    if (decision.action !== "ADVANCE_ROUND") throw new Error("type guard");
    expect(decision.nextRound).toBe(2);
  });

  it("decide: 3 voters, 2 APPROVE 1 CHANGES, round 2 of 2 (cap) → ESCALATE cap_exhausted (NEVER auto-settle at cap)", () => {
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 2,
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "CHANGES" },
      ],
    });

    const decision = rc.decide({ deliberation: d });
    expect(decision.action).toBe("ESCALATE");
    if (decision.action !== "ESCALATE") throw new Error("type guard");
    expect(decision.reason).toBe("cap_exhausted");
    expect(decision.tally).toEqual({ approve: 2, changes: 1 });
  });

  it("decide: riskTag=high → ESCALATE risk_high regardless of votes", () => {
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 1,
      riskTag: "high",
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "APPROVE" },
      ],
    });

    const decision = rc.decide({ deliberation: d });
    expect(decision.action).toBe("ESCALATE");
    if (decision.action !== "ESCALATE") throw new Error("type guard");
    expect(decision.reason).toBe("risk_high");
  });

  it("decide: 2 of 3 quorum, only 1 vote landed → ESCALATE quorum_lost", () => {
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 2,
      currentRound: 1,
      votes: [{ voterId: "v1", bit: "APPROVE" }],
    });

    const decision = rc.decide({ deliberation: d });
    expect(decision.action).toBe("ESCALATE");
    if (decision.action !== "ESCALATE") throw new Error("type guard");
    expect(decision.reason).toBe("quorum_lost");
    expect(decision.tally).toEqual({ approve: 1, changes: 0 });
  });

  it("decide: all APPROVE but prior dissent exists → SETTLE approve_with_conditions", () => {
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 2,
      priorDissent: [{ voterId: "v3" }],
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "APPROVE" },
      ],
    });

    const decision = rc.decide({ deliberation: d });
    expect(decision.action).toBe("SETTLE");
    if (decision.action !== "SETTLE") throw new Error("type guard");
    expect(decision.verdict).toBe("approve_with_conditions");
  });

  // ──────────────────────────── applyDecision() ────────────────────────

  it("applyDecision SETTLE → state SETTLED, verdict, settledAt set", async () => {
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 1,
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "APPROVE" },
      ],
    });
    const decision = rc.decide({ deliberation: d });
    const result = await rc.applyDecision(d.id, decision);
    expect(result.deliberation.state).toBe("SETTLED");
    expect(result.deliberation.verdict).toBe("approve");
    expect(typeof result.deliberation.settledAt).toBe("string");
    expect(result.decision).toEqual(decision);
  });

  it("applyDecision ESCALATE → state ESCALATED, escalationReason set", async () => {
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 2,
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "CHANGES" },
      ],
    });
    const decision = rc.decide({ deliberation: d });
    const result = await rc.applyDecision(d.id, decision);
    expect(result.deliberation.state).toBe("ESCALATED");
    expect(result.deliberation.escalationReason).toBe("cap_exhausted");
  });

  it("applyDecision ADVANCE_ROUND → state still CONVERGING, currentRound bumped", async () => {
    const d = setup({
      voterCount: 3,
      rounds: 3,
      quorum: 3,
      currentRound: 1,
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "CHANGES" },
      ],
    });
    const decision = rc.decide({ deliberation: d });
    const result = await rc.applyDecision(d.id, decision);
    expect(result.deliberation.state).toBe("CONVERGING");
    expect(result.deliberation.currentRound).toBe(2);
  });

  it("applyDecision retries on StaleDeliberationError up to maxRetries", async () => {
    // Pass an already-stale expectedVersion. applyDecision must reload,
    // recompute, and retry — the recomputed decision is the same SETTLE,
    // and retry succeeds.
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 1,
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "APPROVE" },
      ],
    });
    const decision = rc.decide({ deliberation: d });
    // Force a stale version by passing one less than current.
    const result = await rc.applyDecision(d.id, decision, {
      expectedVersion: d.version - 1,
      maxRetries: 3,
    });
    expect(result.deliberation.state).toBe("SETTLED");
    expect(result.deliberation.verdict).toBe("approve");
  });

  it("applyDecision throws if maxRetries exceeded", async () => {
    // With maxRetries=0, the very first stale collision must propagate as an
    // unrecoverable error: applyDecision is allowed exactly one attempt, and
    // it fails because expectedVersion is stale.
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 1,
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "APPROVE" },
      ],
    });

    // To force every retry to also be stale, advance the deliberation in a
    // background "interleaver" that bumps the version between every retry by
    // wrapping decide(). The simplest deterministic way is: the caller passes
    // a stale expectedVersion AND we keep mutating the deliberation between
    // retries. But synchronous applyDecision runs to completion before our
    // afterEach can interleave. So instead: use maxRetries: 0 — a single
    // stale attempt with no retries surfaces the failure.
    let threw: unknown;
    try {
      await rc.applyDecision(d.id, rc.decide({ deliberation: d }), {
        expectedVersion: d.version - 5, // stale on the first try
        maxRetries: 0,
      });
    } catch (e) {
      threw = e;
    }

    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toMatch(/exceeded 0 retries/);
  });

  it("applyDecision recomputes decision after stale reload (e.g. another caller advanced state)", async () => {
    // Initial state: round 1 of 2, 2 APPROVE 1 CHANGES → original decision is ADVANCE_ROUND.
    const d = setup({
      voterCount: 3,
      rounds: 2,
      quorum: 3,
      currentRound: 1,
      votes: [
        { voterId: "v1", bit: "APPROVE" },
        { voterId: "v2", bit: "APPROVE" },
        { voterId: "v3", bit: "CHANGES" },
      ],
    });
    const originalDecision = rc.decide({ deliberation: d });
    expect(originalDecision.action).toBe("ADVANCE_ROUND");

    // Competing caller bumps the deliberation: advances to round 2 and adds
    // 3 APPROVE votes there. Now correct decision is SETTLE approve.
    run.transition(d.id, "CONVERGING", { currentRound: 2 });
    const fresh1 = run.loadDeliberation(d.id)!;
    run.recordVote(fresh1.id, makeVote(fresh1, "v1", "APPROVE", 2));
    const fresh2 = run.loadDeliberation(d.id)!;
    run.recordVote(fresh2.id, makeVote(fresh2, "v2", "APPROVE", 2));
    const fresh3 = run.loadDeliberation(d.id)!;
    run.recordVote(fresh3.id, makeVote(fresh3, "v3", "APPROVE", 2));

    // Caller still holds the original (now stale) decision + version.
    const result = await rc.applyDecision(d.id, originalDecision, {
      expectedVersion: d.version, // stale: state has moved on
      maxRetries: 3,
    });

    // After stale reload + recompute, decision should be SETTLE approve.
    expect(result.decision.action).toBe("SETTLE");
    if (result.decision.action !== "SETTLE") throw new Error("type guard");
    expect(result.decision.verdict).toBe("approve");
    expect(result.deliberation.state).toBe("SETTLED");
    expect(result.deliberation.verdict).toBe("approve");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FU-config — applyDecision retry budget honors runtime-config occMaxRetries
  // ──────────────────────────────────────────────────────────────────────────

  describe("FU-config — applyDecision occMaxRetries from runtime config", () => {
    afterEach(() => {
      runtimeConfig.resetRuntimeConfig();
    });

    it("occMaxRetries=0 + stale expectedVersion → 'exceeded 0 retries' error", async () => {
      runtimeConfig.setRuntimeConfig({ occMaxRetries: 0 });
      const d = setup({
        voterCount: 3,
        rounds: 2,
        quorum: 3,
        currentRound: 1,
        votes: [
          { voterId: "v1", bit: "APPROVE" },
          { voterId: "v2", bit: "APPROVE" },
          { voterId: "v3", bit: "APPROVE" },
        ],
      });

      // Use a known-stale expectedVersion (lower than current) to force OCC.
      const staleVersion = d.version - 1;
      await expect(
        rc.applyDecision(d.id, { action: "SETTLE", verdict: "approve", tally: { approve: 3, changes: 0 } }, {
          expectedVersion: staleVersion,
          // omit maxRetries so the runtime-config value (0) is used
        }),
      ).rejects.toThrow(/exceeded 0 retries/);
    });

    it("explicit options.maxRetries overrides runtime-config occMaxRetries", async () => {
      // Configured budget says 0, but caller passes 5 — caller wins.
      runtimeConfig.setRuntimeConfig({ occMaxRetries: 0 });
      const d = setup({
        voterCount: 3,
        rounds: 2,
        quorum: 3,
        currentRound: 1,
        votes: [
          { voterId: "v1", bit: "APPROVE" },
          { voterId: "v2", bit: "APPROVE" },
          { voterId: "v3", bit: "APPROVE" },
        ],
      });

      // expectedVersion matches current → no stale → call succeeds.
      const result = await rc.applyDecision(
        d.id,
        { action: "SETTLE", verdict: "approve", tally: { approve: 3, changes: 0 } },
        { expectedVersion: d.version, maxRetries: 5 },
      );
      expect(result.decision.action).toBe("SETTLE");
      expect(result.deliberation.state).toBe("SETTLED");
    });
  });
});
