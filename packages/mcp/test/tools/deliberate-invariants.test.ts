// Invariant / stress probe — randomized scenarios driven through the real
// zana_deliberate orchestrator with mocked spawn/probe. Verifies governance
// invariants that the per-feature tests don't cover head-on.
//
// This file is a one-shot diagnostic; safe to delete after the verification run.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana/core/src/project/workspace-context.ts";
import * as core from "@zana/core";
const work = require("@zana/work");
const checkpointStore = work.runs.checkpoint.store;

import {
  deliberateHandler,
  type DeliberateDeps,
} from "../../src/tools/deliberate.ts";

// Fakes ─────────────────────────────────────────────────────────────────────
function profileFor(id: string, model = "claude-opus") {
  return { id, displayName: id, model, description: `lens ${id}` };
}

function fakeProbe(plan: Record<string, "ok" | "timeout" | "spawn">) {
  return async (profile: any) => {
    const o = plan[profile.id] ?? "ok";
    if (o === "ok") {
      return { ok: true, latencyMs: 1, failures: [], modelId: profile.model, probeId: `p-${profile.id}`, legs: [] };
    }
    return { ok: false, latencyMs: 1, failures: [{ leg: "factual", kind: o, reason: `sim ${o}` }], modelId: profile.model, probeId: `p-${profile.id}`, legs: [] };
  };
}

function fakeAgentPair(script: Record<number, Record<string, { bit: "APPROVE" | "CHANGES"; rationale: string }>>, state: { round: number }) {
  let nextId = 0;
  const agents = new Map<string, any>();
  // Track profile IDs seen this round; on repeat, bump round.
  let seenThisRound = new Set<string>();
  return {
    spawnHeadlessAgent: (profile: any) => {
      if (seenThisRound.has(profile.id)) {
        state.round++;
        seenThisRound = new Set();
      }
      seenThisRound.add(profile.id);
      const id = `fake-${profile.id}-${++nextId}`;
      const cell = script[state.round]?.[profile.id];
      const result = cell ? JSON.stringify(cell) : JSON.stringify({ bit: "CHANGES", rationale: "no script" });
      agents.set(id, { id, profileId: profile.id, state: "terminated", result, outputBuffer: result });
      return { agentId: id, terminalId: `t-${id}` };
    },
    getAgent: (id: string) => agents.get(id) ?? null,
    killAgent: (id: string) => agents.delete(id),
  };
}

function makeDeps(
  script: Record<number, Record<string, { bit: "APPROVE" | "CHANGES"; rationale: string }>>,
  state: { round: number },
  probeOutcomes: Record<string, "ok" | "timeout" | "spawn"> = {},
): DeliberateDeps {
  const pair = fakeAgentPair(script, state);
  return {
    probeAgent: fakeProbe(probeOutcomes),
    spawnHeadlessAgent: pair.spawnHeadlessAgent,
    getAgent: pair.getAgent,
    killAgent: pair.killAgent,
    getProfile: (id) => profileFor(id),
    pollIntervalMs: 1,
    timeoutMs: 5000,
    maxIterations: 32,
  };
}

// Invariant assertions ──────────────────────────────────────────────────────
function assertInvariants(d: any, scenario: string, opts: { voters: string[]; rounds: number; riskTag: "low" | "medium" | "high" }) {
  const tag = `[${scenario}]`;

  // Terminal state
  expect(["SETTLED", "ESCALATED"], `${tag} terminal`).toContain(d.state);

  // Version monotone & positive
  expect(d.version, `${tag} version positive`).toBeGreaterThan(0);

  // No vote outside [1, rounds]
  for (const v of d.votes) {
    expect(v.round, `${tag} vote.round in range`).toBeGreaterThanOrEqual(1);
    expect(v.round, `${tag} vote.round <= rounds`).toBeLessThanOrEqual(opts.rounds);
    expect(v.bit, `${tag} vote.bit valid`).toMatch(/^(APPROVE|CHANGES)$/);
    expect(v.rationaleHash, `${tag} rationaleHash sha256`).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(v.promptSnapshotHash, `${tag} promptSnapshotHash sha256`).toMatch(/^sha256:[a-f0-9]{64}$/);
  }

  // No duplicate voterId in same round
  const seen = new Set<string>();
  for (const v of d.votes) {
    const key = `${v.round}:${v.voterId}`;
    expect(seen.has(key), `${tag} no duplicate vote ${key}`).toBe(false);
    seen.add(key);
  }

  // All dissents map to a CHANGES vote in same round
  for (const ds of d.dissent) {
    const matched = d.votes.find((v: any) => v.profileId === ds.profileId && v.round === ds.round && v.bit === "CHANGES");
    expect(matched, `${tag} dissent ${ds.profileId} r${ds.round} has matching CHANGES vote`).toBeTruthy();
    expect(ds.rationaleHash, `${tag} dissent rationaleHash sha256`).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ds.ts, `${tag} dissent ts non-empty`).toBeTruthy();
  }

  // SETTLED invariants
  if (d.state === "SETTLED") {
    expect(d.verdict, `${tag} settled has verdict`).toBeTruthy();
    expect(d.settledAt, `${tag} settled has settledAt`).toBeTruthy();

    if (d.verdict === "approve" || d.verdict === "approve_with_conditions") {
      // The settling round must be all APPROVE (no CHANGES dissent in current round)
      const finalRound = d.currentRound;
      const inFinal = d.votes.filter((v: any) => v.round === finalRound);
      const changesInFinal = inFinal.filter((v: any) => v.bit === "CHANGES").length;
      expect(changesInFinal, `${tag} settled final round has no CHANGES`).toBe(0);

      // approve_with_conditions ⇒ at least one prior dissent
      if (d.verdict === "approve_with_conditions") {
        expect(d.dissent.length, `${tag} approve_with_conditions has dissent`).toBeGreaterThan(0);
      } else if (d.verdict === "approve") {
        expect(d.dissent.length, `${tag} approve has no dissent`).toBe(0);
      }
    }
  }

  // ESCALATED invariants
  if (d.state === "ESCALATED") {
    expect(d.escalationReason, `${tag} escalated has reason`).toBeTruthy();

    if (d.escalationReason === "risk_high") {
      expect(opts.riskTag, `${tag} risk_high requires high risk`).toBe("high");
    }

    if (d.escalationReason === "cap_exhausted") {
      expect(d.currentRound, `${tag} cap_exhausted at cap`).toBe(opts.rounds);
      const inFinal = d.votes.filter((v: any) => v.round === d.currentRound);
      const changesInFinal = inFinal.filter((v: any) => v.bit === "CHANGES").length;
      expect(changesInFinal, `${tag} cap_exhausted has CHANGES at cap`).toBeGreaterThan(0);
    }

    if (d.escalationReason === "quorum_lost") {
      // Either probe drops took us below quorum, or fewer votes recorded than quorum in current round.
      // Both surfaces are valid — just assert NOT a tally-met state.
      const inFinal = d.votes.filter((v: any) => v.round === d.currentRound);
      const tallyMet = inFinal.length >= d.quorum;
      const dropouts = (d.degradation || []).reduce((acc: number, e: any) => acc + e.dropped.length, 0);
      // If tally was met AND no degradation, escalation reason must not be quorum_lost.
      if (tallyMet && dropouts === 0) {
        throw new Error(`${tag} quorum_lost but tally met with no dropouts (votes=${inFinal.length}, quorum=${d.quorum})`);
      }
    }
  }

  // Synthesis hash present once past REVIEWING (any non-REVIEWING/PROPOSED state with at least one round)
  if ((d.state === "SETTLED" || d.state === "ESCALATED") && d.currentRound >= 1 && d.escalationReason !== "risk_high" && d.escalationReason !== "quorum_lost" && d.state !== "ESCALATED") {
    expect(d.synthesisHash, `${tag} synthesisHash present after first round`).toMatch(/^sha256:[a-f0-9]{64}$/);
  }

  // voters[] populated to exactly the surviving candidates (or zero if escalated_at_assembly)
  if (d.voters.length > 0) {
    for (const v of d.voters) {
      expect(opts.voters, `${tag} voter ${v.profileId} in candidate set`).toContain(v.profileId);
    }
  }
}

// Setup ─────────────────────────────────────────────────────────────────────
describe("zana_deliberate — invariant stress probe", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-invariant-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // Seeded PRNG for reproducibility
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it("50 randomized scenarios — all invariants hold", async () => {
    const r = rng(0xdeadbeef);
    const scenarios = 50;
    const verdicts = new Map<string, number>();

    for (let i = 0; i < scenarios; i++) {
      // Random configuration
      const voterCount = 3 + Math.floor(r() * 3); // 3..5
      const rounds = 1 + Math.floor(r() * 3); // 1..3
      const voters = Array.from({ length: voterCount }, (_, k) => `voter-${k}`);
      const riskTag: "low" | "medium" | "high" = r() < 0.1 ? "high" : r() < 0.5 ? "low" : "medium";
      const quorumChoice = r();
      const quorum: number | "majority" | "all" =
        quorumChoice < 0.4 ? "majority" : quorumChoice < 0.7 ? "all" : Math.max(1, Math.floor(r() * voterCount));

      // Per-round, per-voter script — random APPROVE/CHANGES
      const script: Record<number, Record<string, { bit: "APPROVE" | "CHANGES"; rationale: string }>> = {};
      for (let round = 1; round <= rounds; round++) {
        script[round] = {};
        for (const v of voters) {
          // Bias later rounds toward APPROVE so some converge
          const approveProb = round === 1 ? 0.55 : 0.75;
          const bit: "APPROVE" | "CHANGES" = r() < approveProb ? "APPROVE" : "CHANGES";
          script[round][v] = {
            bit,
            rationale: bit === "APPROVE" ? `Looks ok at round ${round}` : `Should fix X at round ${round} — security concern`,
          };
        }
      }

      // Random probe failures (drop up to 1 voter ~30% of the time)
      const probeOutcomes: Record<string, "ok" | "timeout" | "spawn"> = {};
      if (r() < 0.3 && voterCount > 1) {
        const drop = voters[Math.floor(r() * voters.length)];
        probeOutcomes[drop] = r() < 0.5 ? "timeout" : "spawn";
      }

      const state = { round: 1 };
      const deps = makeDeps(script, state, probeOutcomes);

      let result: any;
      try {
        result = await deliberateHandler({
      wait: true,
          question: `scenario ${i}`,
          voters,
          rounds,
          quorum,
          riskTag,
          deps,
        });
      } catch (err: any) {
        // Should never throw — but if it does, surface it loudly with the scenario.
        throw new Error(`scenario ${i} threw: ${err?.message || err}\nconfig=${JSON.stringify({ voterCount, rounds, riskTag, quorum, probeOutcomes })}`);
      }

      // Hack: collectReviews is called before script[state.round] update — orchestrator does
      // round bumping; for our fake to track the round, peek at the result and align.
      // (Not a real bug, just our fake. The orchestrator bumps state.round implicitly via
      // the spawn loop iterating; we rely on the fact that script[round] is keyed correctly.)

      assertInvariants(result, `s${i}`, { voters, rounds, riskTag });

      // Bookkeep verdict distribution
      const key = result.state === "SETTLED" ? `SETTLED:${result.verdict}` : `ESCALATED:${result.escalationReason}`;
      verdicts.set(key, (verdicts.get(key) ?? 0) + 1);
    }

    // Sanity — we should have exercised multiple verdict types
    // (won't fail the test if not — just informational)
    // eslint-disable-next-line no-console
    console.log("verdict distribution:", Object.fromEntries(verdicts));
    expect(verdicts.size, "exercised multiple outcome types").toBeGreaterThanOrEqual(2);
  }, 60000);

  // ──────────────────────────────────────────────────────────────────────────
  // Edge: 1-voter quorum=all, single round, APPROVE → SETTLED
  // ──────────────────────────────────────────────────────────────────────────
  it("1-voter quorum=all single-round APPROVE → SETTLED approve", async () => {
    const state = { round: 1 };
    const script = { 1: { solo: { bit: "APPROVE" as const, rationale: "yes" } } };
    const deps = makeDeps(script, state);
    const r = await deliberateHandler({
      wait: true,
      question: "single-voter sanity",
      voters: ["solo"],
      rounds: 1,
      quorum: "all",
      deps,
    });
    expect(r.state).toBe("SETTLED");
    expect(r.verdict).toBe("approve");
    assertInvariants(r, "1voter", { voters: ["solo"], rounds: 1, riskTag: "medium" });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Edge: explicit numeric quorum higher than voterCount → all candidates
  //       must vote, otherwise quorum_lost
  // ──────────────────────────────────────────────────────────────────────────
  it("numeric quorum=3 with 3 voters all APPROVE → SETTLED", async () => {
    const state = { round: 1 };
    const script = {
      1: {
        a: { bit: "APPROVE" as const, rationale: "ok" },
        b: { bit: "APPROVE" as const, rationale: "ok" },
        c: { bit: "APPROVE" as const, rationale: "ok" },
      },
    };
    const deps = makeDeps(script, state);
    const r = await deliberateHandler({
      wait: true,
      question: "numeric quorum",
      voters: ["a", "b", "c"],
      rounds: 1,
      quorum: 3,
      deps,
    });
    expect(r.state).toBe("SETTLED");
    expect(r.verdict).toBe("approve");
    expect(r.quorum).toBe(3);
    assertInvariants(r, "numeric-quorum", { voters: ["a", "b", "c"], rounds: 1, riskTag: "medium" });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Edge: numeric quorum > surviving voters after probe drop → quorum_lost
  // ──────────────────────────────────────────────────────────────────────────
  it("numeric quorum=3, one voter probe-fails → ESCALATED at assembly", async () => {
    const state = { round: 1 };
    const script = {
      1: {
        a: { bit: "APPROVE" as const, rationale: "ok" },
        b: { bit: "APPROVE" as const, rationale: "ok" },
      },
    };
    const deps = makeDeps(script, state, { c: "timeout" });
    const r = await deliberateHandler({
      wait: true,
      question: "quorum drop",
      voters: ["a", "b", "c"],
      rounds: 1,
      quorum: 3,
      deps,
    });
    expect(r.state).toBe("ESCALATED");
    expect(r._outcome).toBe("escalated_at_assembly");
    expect(r._assemblyEscalation.reason).toBe("quorum_lost");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Audit: dissent verbatim — same rationale text appears at both vote AND
  // dissent ends (via rationaleHash equality)
  // ──────────────────────────────────────────────────────────────────────────
  it("dissent rationaleHash matches the originating vote's rationaleHash byte-for-byte", async () => {
    const state = { round: 1 };
    const script = {
      1: {
        a: { bit: "CHANGES" as const, rationale: "Critical: missing CSRF check" },
        b: { bit: "APPROVE" as const, rationale: "ok" },
        c: { bit: "APPROVE" as const, rationale: "ok" },
      },
      2: {
        a: { bit: "APPROVE" as const, rationale: "fixed, ok" },
        b: { bit: "APPROVE" as const, rationale: "ok" },
        c: { bit: "APPROVE" as const, rationale: "ok" },
      },
    };
    const deps = makeDeps(script, state);
    const r = await deliberateHandler({
      wait: true,
      question: "dissent integrity",
      voters: ["a", "b", "c"],
      rounds: 2,
      deps,
    });
    expect(r.state).toBe("SETTLED");
    expect(r.verdict).toBe("approve_with_conditions");

    const round1Dissents = r.dissent.filter((d: any) => d.round === 1);
    expect(round1Dissents.length).toBeGreaterThan(0);
    for (const ds of round1Dissents) {
      const matchingVote = r.votes.find((v: any) => v.profileId === ds.profileId && v.round === 1 && v.bit === "CHANGES");
      expect(matchingVote, "matching CHANGES vote exists").toBeTruthy();
      expect(ds.rationaleHash, "dissent hash == vote hash (verbatim)").toBe(matchingVote.rationaleHash);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Audit: anti-dropout-bias — round 1 dissenter probes-fail in round 2 →
  //        ESCALATED dropout_was_dissenter
  // ──────────────────────────────────────────────────────────────────────────
  it("anti-dropout: round 1 dissenter dropped in round 2 reassemble → ESCALATED dropout_was_dissenter", async () => {
    const state = { round: 1 };
    const script = {
      1: {
        a: { bit: "CHANGES" as const, rationale: "Critical concern about X" },
        b: { bit: "APPROVE" as const, rationale: "ok" },
        c: { bit: "APPROVE" as const, rationale: "ok" },
      },
      2: {
        a: { bit: "APPROVE" as const, rationale: "ok" },
        b: { bit: "APPROVE" as const, rationale: "ok" },
        c: { bit: "APPROVE" as const, rationale: "ok" },
      },
    };

    // Probe map that flips: round 1 all OK, round 2 'a' fails. We can't easily
    // mutate per-round in a single fakeProbe, so use a counter.
    let probeCallCount: Record<string, number> = {};
    const probeAgent = async (profile: any) => {
      probeCallCount[profile.id] = (probeCallCount[profile.id] ?? 0) + 1;
      // First call (initial assemble) all OK; second call (reassemble) → 'a' fails.
      if (probeCallCount[profile.id] >= 2 && profile.id === "a") {
        return { ok: false, latencyMs: 1, failures: [{ leg: "factual", kind: "timeout", reason: "sim" }], modelId: profile.model, probeId: "p", legs: [] };
      }
      return { ok: true, latencyMs: 1, failures: [], modelId: profile.model, probeId: "p", legs: [] };
    };

    const pair = fakeAgentPair(script, state);
    const deps: DeliberateDeps = {
      probeAgent,
      spawnHeadlessAgent: pair.spawnHeadlessAgent,
      getAgent: pair.getAgent,
      killAgent: pair.killAgent,
      getProfile: (id) => profileFor(id),
      pollIntervalMs: 1,
      timeoutMs: 5000,
      maxIterations: 32,
    };

    const r = await deliberateHandler({
      wait: true,
      question: "anti-dropout-bias",
      voters: ["a", "b", "c"],
      rounds: 2,
      deps,
    });

    expect(r.state).toBe("ESCALATED");
    expect(r._outcome).toBe("escalated_during_reassembly");
    expect(r._reassemblyEscalation.reason).toBe("dropout_was_dissenter");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Audit: cap_exhausted with persistent CHANGES → never settles
  // ──────────────────────────────────────────────────────────────────────────
  it("persistent CHANGES across all rounds → ESCALATED cap_exhausted, never auto-settles", async () => {
    const state = { round: 1 };
    const script: any = {};
    for (let r = 1; r <= 3; r++) {
      script[r] = {
        a: { bit: "CHANGES", rationale: `still broken r${r}` },
        b: { bit: "APPROVE", rationale: "fine" },
        c: { bit: "APPROVE", rationale: "fine" },
      };
    }
    const deps = makeDeps(script, state);
    const r = await deliberateHandler({
      wait: true,
      question: "cap stress",
      voters: ["a", "b", "c"],
      rounds: 3,
      deps,
    });
    expect(r.state).toBe("ESCALATED");
    expect(r.escalationReason).toBe("cap_exhausted");
    expect(r.verdict).toBeUndefined(); // never auto-pick at cap
    assertInvariants(r, "cap-stress", { voters: ["a", "b", "c"], rounds: 3, riskTag: "medium" });
  });
});
