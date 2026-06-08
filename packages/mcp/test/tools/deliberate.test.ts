// T9 — zana_deliberate MCP tool tests.
//
// Exercises the full propose → assemble → review → synthesize → record →
// decide → applyDecision (→ reassemble) loop with injected fakes for every
// external touchpoint. No real Claude spawning.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
// IMPORTANT: import @zana-ai/work via the package entry, not @zana-ai/work/src/...,
// so we share the SAME module instance with deliberate.ts (which uses
// `require("@zana-ai/work")` at runtime). The src-deep paths resolve as a
// separate module under Vite's noExternal, which would cause the
// deliberation checkpoints to land in a different in-memory dir than the one
// the handler reads from.
const work = require("@zana-ai/work");
const checkpointStore = work.runs.checkpoint.store;
const artifactStore = work.runs.artifacts;
const run = work.deliberation;

import {
  deliberateHandler,
  deliberationStatusHandler,
  deliberationListHandler,
  deliberationOverrideHandler,
  type DeliberateDeps,
} from "../../src/tools/deliberate.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

function profileFor(id: string, model = "claude-opus") {
  return { id, displayName: id, model, description: `lens ${id}` };
}

type ProbeOutcome = "ok" | "timeout" | "spawn";

/** Minimal probeAgent fake — drives quorum scenarios without booting agents. */
function fakeProbe(plan: Record<string, ProbeOutcome>) {
  return async (profile: any) => {
    const o = plan[profile.id] ?? "ok";
    if (o === "ok") {
      return {
        ok: true,
        latencyMs: 1,
        failures: [],
        modelId: profile.model || "unknown",
        probeId: `probe-${profile.id}`,
        legs: [],
      };
    }
    return {
      ok: false,
      latencyMs: 1,
      failures: [{ leg: "factual", kind: o, reason: `simulated ${o}` }],
      modelId: profile.model || "unknown",
      probeId: `probe-${profile.id}`,
      legs: [],
    };
  };
}

/**
 * Build a fake spawn/get pair driven by a per-round, per-profile script.
 * `script[round][profileId] = { bit, rationale }` describes what each voter
 * "produces" when spawned in that round.
 */
function fakeAgentPair(
  script: Record<number, Record<string, { bit: "APPROVE" | "CHANGES"; rationale: string }>>,
  state: { round: number },
) {
  let nextId = 0;
  const agents = new Map<string, any>();

  const spawnHeadlessAgent = (profile: any, _options: any) => {
    const id = `fake-${profile.id}-${++nextId}`;
    const cell = script[state.round]?.[profile.id];
    const result = cell
      ? JSON.stringify({ bit: cell.bit, rationale: cell.rationale })
      : JSON.stringify({ bit: "CHANGES", rationale: "[no script entry]" });
    // Return immediately as terminated — collectReviews polls every 1ms.
    agents.set(id, {
      id,
      profileId: profile.id,
      state: "terminated",
      result,
      outputBuffer: result,
    });
    return { agentId: id, terminalId: `term-${id}` };
  };

  const getAgent = (id: string) => agents.get(id) ?? null;
  const killAgent = (id: string) => agents.delete(id);

  return { spawnHeadlessAgent, getAgent, killAgent, _agents: agents };
}

function makeDeps(
  script: Record<number, Record<string, { bit: "APPROVE" | "CHANGES"; rationale: string }>>,
  state: { round: number },
  probeOutcomes: Record<string, ProbeOutcome> = {},
  profileResolver?: (id: string) => any,
): DeliberateDeps {
  const pair = fakeAgentPair(script, state);
  const probe = fakeProbe(probeOutcomes);
  return {
    probeAgent: probe,
    spawnHeadlessAgent: pair.spawnHeadlessAgent,
    getAgent: pair.getAgent,
    killAgent: pair.killAgent,
    getProfile: profileResolver ?? ((id: string) => profileFor(id)),
    pollIntervalMs: 1,
    timeoutMs: 5000,
    maxIterations: 32,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────────

describe("zana_deliberate MCP tool family (T9)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-mcp-delib-"));
    // Pre-create .zana/ here so resolveProjectDir anchors at tmpRoot rather
    // than walking up to a shared /tmp/.zana that may be quarantined on macOS.
    require("node:fs").mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Happy path — all APPROVE → SETTLED
  // ──────────────────────────────────────────────────────────────────────────
  it("end-to-end happy path with mocked spawn → SETTLED with verdict approve", async () => {
    const state = { round: 1 };
    const script = {
      1: {
        a: { bit: "APPROVE" as const, rationale: "Looks great. Approving." },
        b: { bit: "APPROVE" as const, rationale: "Solid. Approving." },
        c: { bit: "APPROVE" as const, rationale: "All good. Approving." },
      },
    };
    const deps = makeDeps(script, state);

    const result = await deliberateHandler({
      wait: true,
      question: "Adopt argument-based synthesis as the default reducer?",
      voters: ["a", "b", "c"],
      deps,
    });

    expect(result.state).toBe("SETTLED");
    expect(result.verdict).toBe("approve");
    // 3 votes recorded for round 1, all APPROVE.
    expect(result.votes).toHaveLength(3);
    for (const v of result.votes) {
      expect(v.bit).toBe("APPROVE");
      expect(v.round).toBe(1);
      expect(v.rationaleHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(result.dissent).toEqual([]);
    expect(result._outcome).toBe("settled");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. risk_high → ESCALATED regardless of votes
  // ──────────────────────────────────────────────────────────────────────────
  it("riskTag=high → ESCALATED risk_high regardless of unanimous APPROVE", async () => {
    const state = { round: 1 };
    const script = {
      1: {
        a: { bit: "APPROVE" as const, rationale: "ok" },
        b: { bit: "APPROVE" as const, rationale: "ok" },
        c: { bit: "APPROVE" as const, rationale: "ok" },
      },
    };
    const deps = makeDeps(script, state);

    const result = await deliberateHandler({
      wait: true,
      question: "high risk action",
      voters: ["a", "b", "c"],
      riskTag: "high",
      deps,
    });

    expect(result.state).toBe("ESCALATED");
    expect(result.escalationReason).toBe("risk_high");
    expect(result._outcome).toBe("escalated");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. quorum_lost on assembly → ESCALATED at assembly
  // ──────────────────────────────────────────────────────────────────────────
  it("quorum lost during initial probe → ESCALATED at assembly", async () => {
    const state = { round: 1 };
    const deps = makeDeps(
      {},
      state,
      { a: "ok", b: "timeout", c: "timeout" }, // only 1/3 OK; majority quorum=2
    );

    const result = await deliberateHandler({
      wait: true,
      question: "q",
      voters: ["a", "b", "c"],
      deps,
    });

    expect(result.state).toBe("ESCALATED");
    expect(result.escalationReason).toBe("quorum_lost");
    expect(result._outcome).toBe("escalated_at_assembly");
    expect(result._assemblyEscalation?.reason).toBe("quorum_lost");
  });

  it("assembly escalation surfaces voterFailures[] with typed kind/leg", async () => {
    const state = { round: 1 };
    const deps = makeDeps(
      {},
      state,
      { a: "ok", b: "timeout", c: "timeout" },
    );

    const result = await deliberateHandler({
      wait: true,
      question: "q",
      voters: ["a", "b", "c"],
      deps,
    });

    expect(result._outcome).toBe("escalated_at_assembly");
    const esc = result._assemblyEscalation;
    expect(esc?.reason).toBe("quorum_lost");
    expect(Array.isArray(esc?.voterFailures)).toBe(true);
    // Two voters dropped (b and c), order matches assembleCouncil's iteration.
    const ids = esc.voterFailures.map((f: any) => f.profileId).sort();
    expect(ids).toEqual(["b", "c"]);
    for (const f of esc.voterFailures) {
      expect(f.kind).toBe("timeout");
      expect(f.leg).toBe("factual");           // fakeProbe writes leg: "factual"
      expect(typeof f.reason).toBe("string");
      expect(f.reason.length).toBeGreaterThan(0);
    }
    expect(typeof esc.nextSteps).toBe("string");
    expect(esc.nextSteps).toContain("audit.ndjson");
    // Backward compat: top-level deliberation fields still present.
    expect(typeof result.version).toBe("number");
    expect(result.version).toBeGreaterThan(0);
    expect(Array.isArray(result.degradation)).toBe(true);
  });

  it("voterFailures[].kind reflects each ProbeFailureKind passed through unchanged", async () => {
    // Three voters drop with distinct kinds; quorum=2 of 3 means we need
    // 2 to PASS, so we pass 0 and drop all 3 → ESCALATED.
    const kinds = ["timeout", "spawn"] as const; // ProbeOutcome union limits us to these two failure kinds via the fake; that's enough to prove pass-through.
    for (const k of kinds) {
      const state = { round: 1 };
      const deps = makeDeps(
        {},
        state,
        { a: k, b: k, c: k },
      );
      const result = await deliberateHandler({
        wait: true,
        question: `q-${k}`,
        voters: ["a", "b", "c"],
        deps,
      });
      expect(result._outcome).toBe("escalated_at_assembly");
      const esc = result._assemblyEscalation;
      for (const f of esc.voterFailures) {
        expect(f.kind).toBe(k);
      }
    }
  });

  it("skipProbe:true bypasses probes and proceeds to review even when probes would fail", async () => {
    // Plan calls for two voters to time out — would normally drop quorum.
    const state = { round: 1 };
    const script = {
      1: {
        a: { bit: "APPROVE" as const, rationale: "ok" },
        b: { bit: "APPROVE" as const, rationale: "ok" },
        c: { bit: "APPROVE" as const, rationale: "ok" },
      },
    };
    // makeDeps wires fakeProbe based on the third arg; we also override
    // probeAgent to assert it's NOT called when skipProbe is set.
    const deps = makeDeps(
      script,
      state,
      { a: "ok", b: "timeout", c: "timeout" },
    );
    let probeCalls = 0;
    const origProbe = deps.probeAgent!;
    deps.probeAgent = async (...args: any[]) => {
      probeCalls++;
      return origProbe(...(args as [any, any?, any?]));
    };

    const result = await deliberateHandler({
      wait: true,
      question: "q",
      voters: ["a", "b", "c"],
      quorum: 2,
      skipProbe: true,
      deps,
    });

    expect(probeCalls).toBe(0); // probeAgent never invoked
    expect(result._outcome).not.toBe("escalated_at_assembly");
    // All three voters survived → council reached SETTLED unanimously.
    expect(result.state).toBe("SETTLED");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. ADVANCE_ROUND triggers reassembleCouncil
  // ──────────────────────────────────────────────────────────────────────────
  it("ADVANCE_ROUND triggers reassembleCouncil — round 1 mixed, round 2 unanimous", async () => {
    const state = { round: 1 };
    const script = {
      1: {
        a: { bit: "APPROVE" as const, rationale: "Looks fine." },
        b: { bit: "APPROVE" as const, rationale: "Looks fine." },
        c: { bit: "CHANGES" as const, rationale: "Need to reconsider X." },
      },
      2: {
        a: { bit: "APPROVE" as const, rationale: "Round 2 still good." },
        b: { bit: "APPROVE" as const, rationale: "Round 2 still good." },
        c: { bit: "APPROVE" as const, rationale: "Concerns addressed." },
      },
    };
    // bumpRound after collectReviews completes for round 1
    const deps = makeDeps(script, state);
    // Override spawn so it advances the round-counter mid-call.
    const origSpawn = deps.spawnHeadlessAgent!;
    let callsThisRound = 0;
    deps.spawnHeadlessAgent = (profile: any, options: any) => {
      const r = origSpawn(profile, options);
      callsThisRound++;
      if (callsThisRound === 3) {
        // After all 3 voters spawned for round 1, bump the round so the next
        // batch reads from script[2].
        callsThisRound = 0;
        // Defer the bump — when round-2 spawns happen, state.round must be 2.
        Promise.resolve().then(() => { state.round = 2; });
      }
      return r;
    };

    const result = await deliberateHandler({
      wait: true,
      question: "Should we proceed?",
      voters: ["a", "b", "c"],
      rounds: 3,
      deps,
    });

    expect(result.state).toBe("SETTLED");
    expect(result.verdict).toBe("approve_with_conditions");
    // 3 votes per round × 2 rounds = 6.
    expect(result.votes).toHaveLength(6);
    // Round 1 had a CHANGES vote → at least one dissent recorded.
    expect(result.dissent.length).toBeGreaterThanOrEqual(1);
    expect(result.dissent[0].round).toBe(1);
    expect(result.currentRound).toBe(2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. cap_exhausted → ESCALATED
  // ──────────────────────────────────────────────────────────────────────────
  it("cap exhausted with persistent dissent → ESCALATED cap_exhausted", async () => {
    const state = { round: 1 };
    // Both rounds have a CHANGES vote — never converges.
    const baseRoundScript = {
      a: { bit: "APPROVE" as const, rationale: "ok" },
      b: { bit: "APPROVE" as const, rationale: "ok" },
      c: { bit: "CHANGES" as const, rationale: "still concerns" },
    };
    const script = { 1: baseRoundScript, 2: baseRoundScript };
    const deps = makeDeps(script, state);
    const origSpawn = deps.spawnHeadlessAgent!;
    let calls = 0;
    deps.spawnHeadlessAgent = (profile: any, options: any) => {
      const r = origSpawn(profile, options);
      calls++;
      if (calls === 3) {
        calls = 0;
        Promise.resolve().then(() => { state.round = 2; });
      }
      return r;
    };

    const result = await deliberateHandler({
      wait: true,
      question: "Persistent dissent",
      voters: ["a", "b", "c"],
      rounds: 2,
      deps,
    });

    expect(result.state).toBe("ESCALATED");
    expect(result.escalationReason).toBe("cap_exhausted");
    expect(result._outcome).toBe("escalated");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5b. dissent is preserved across multiple rounds
  //
  // Round 1: 2 APPROVE + 1 CHANGES → ADVANCE_ROUND.
  // Round 2: 3 APPROVE → SETTLED.
  // Round 1's CHANGES voter MUST have a dissent recorded — without that the
  // minority report is silently collapsed when the council eventually
  // converges. (Original bug: synthesis only fired in REVIEWING, so round 1
  // dissent WAS captured but later rounds' would not be — this test pins the
  // round-1 path is still intact.)
  // ──────────────────────────────────────────────────────────────────────────
  it("dissent is preserved across multiple rounds (round 1 dissent → round 2 unanimous)", async () => {
    const state = { round: 1 };
    const script = {
      1: {
        a: { bit: "APPROVE" as const, rationale: "Approving." },
        b: { bit: "APPROVE" as const, rationale: "Approving." },
        c: { bit: "CHANGES" as const, rationale: "Concerns about scope." },
      },
      2: {
        a: { bit: "APPROVE" as const, rationale: "Round 2 still good." },
        b: { bit: "APPROVE" as const, rationale: "Round 2 still good." },
        c: { bit: "APPROVE" as const, rationale: "Concerns addressed." },
      },
    };
    const deps = makeDeps(script, state);
    const origSpawn = deps.spawnHeadlessAgent!;
    let calls = 0;
    deps.spawnHeadlessAgent = (profile: any, options: any) => {
      const r = origSpawn(profile, options);
      calls++;
      if (calls === 3) {
        calls = 0;
        Promise.resolve().then(() => { state.round = 2; });
      }
      return r;
    };

    const result = await deliberateHandler({
      wait: true,
      question: "Multi-round dissent preservation",
      voters: ["a", "b", "c"],
      rounds: 3,
      deps,
    });

    expect(result.state).toBe("SETTLED");
    expect(result.verdict).toBe("approve_with_conditions");
    // The minority report from round 1 must still exist on the final
    // deliberation — never collapsed even though round 2 was unanimous.
    expect(result.dissent.length).toBeGreaterThanOrEqual(1);
    expect(result.dissent.some((d: any) => d.round === 1)).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5c. dissent on cap_exhausted — round 1 AND round 2 dissent both recorded
  //
  // This is the assertion that would have caught the original bug: with
  // synthesis gated on `state === "REVIEWING"`, round-2 CHANGES rationales
  // were tallied but NEVER content-addressed or appended to dissent.
  // ──────────────────────────────────────────────────────────────────────────
  it("dissent on cap_exhausted scenario — round 1 AND round 2 dissents both recorded", async () => {
    const state = { round: 1 };
    const baseRoundScript = {
      a: { bit: "APPROVE" as const, rationale: "ok" },
      b: { bit: "APPROVE" as const, rationale: "ok" },
      c: { bit: "CHANGES" as const, rationale: "still concerns" },
    };
    const script = { 1: baseRoundScript, 2: baseRoundScript };
    const deps = makeDeps(script, state);
    const origSpawn = deps.spawnHeadlessAgent!;
    let calls = 0;
    deps.spawnHeadlessAgent = (profile: any, options: any) => {
      const r = origSpawn(profile, options);
      calls++;
      if (calls === 3) {
        calls = 0;
        Promise.resolve().then(() => { state.round = 2; });
      }
      return r;
    };

    const result = await deliberateHandler({
      wait: true,
      question: "Dissent must persist on cap_exhausted",
      voters: ["a", "b", "c"],
      rounds: 2,
      deps,
    });

    expect(result.state).toBe("ESCALATED");
    expect(result.escalationReason).toBe("cap_exhausted");
    // Both rounds' dissent rationales must be content-addressed.
    expect(result.dissent.some((d: any) => d.round === 1)).toBe(true);
    expect(result.dissent.some((d: any) => d.round === 2)).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. status — load by id
  // ──────────────────────────────────────────────────────────────────────────
  it("zana_deliberation_status returns the loaded deliberation", async () => {
    // Seed a deliberation directly via run.propose (skips the loop).
    const d = run.propose({
      question: "status?",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });
    const loaded = deliberationStatusHandler({ deliberationId: d.id });
    expect(loaded.id).toBe(d.id);
    expect(loaded.state).toBe("PROPOSED");
    expect(loaded.question).toBe("status?");

    // Unknown id → throws.
    expect(() => deliberationStatusHandler({ deliberationId: "missing" })).toThrow(/deliberation not found/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. list — filter by state
  // ──────────────────────────────────────────────────────────────────────────
  it("zana_deliberation_list filters by state", async () => {
    const d1 = run.propose({ question: "q1", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    const d2 = run.propose({ question: "q2", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    // Move d2 to ESCALATED so the filter splits.
    run.transition(d2.id, "ESCALATED", { escalationReason: "explicit" });

    const allProposed = deliberationListHandler({ state: "PROPOSED" });
    expect(allProposed.map((x: any) => x.id)).toContain(d1.id);
    expect(allProposed.map((x: any) => x.id)).not.toContain(d2.id);

    const escalated = deliberationListHandler({ state: "ESCALATED" });
    expect(escalated.map((x: any) => x.id)).toContain(d2.id);

    const noFilter = deliberationListHandler({});
    expect(noFilter.length).toBeGreaterThanOrEqual(2);
    // Each summary has the expected shape.
    for (const s of noFilter) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.state).toBe("string");
      expect(typeof s.question).toBe("string");
      expect(typeof s.createdAt).toBe("string");
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 8. override — stamps reasonHash and lands the deliberation on SETTLED
  // ──────────────────────────────────────────────────────────────────────────
  it("zana_deliberation_override stamps reasonHash and transitions to SETTLED", async () => {
    const d = run.propose({
      question: "needs human?",
      voters: [{ profileId: "a" }],
      promptSnapshot: "p",
    });
    // Move to ESCALATED so override transitions ESCALATED → SETTLED.
    run.transition(d.id, "ESCALATED", { escalationReason: "explicit" });

    const updated = deliberationOverrideHandler({
      deliberationId: d.id,
      decision: "approve",
      reason: "Reviewed offline; approved per CTO 2026-05-19.",
    });

    expect(updated.state).toBe("SETTLED");
    expect(updated.override).toBeDefined();
    expect(updated.override.decision).toBe("approve");
    expect(updated.override.humanId).toBe("human");
    expect(updated.override.reasonHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Reason was stored content-addressed and is retrievable.
    const blob = artifactStore.readContentAddressed(updated.override.reasonHash);
    expect(blob).not.toBeNull();
    expect(blob!.toString("utf8")).toContain("CTO 2026-05-19");

    // Validation: missing/bad inputs throw.
    expect(() => deliberationOverrideHandler({
      deliberationId: "",
      decision: "approve",
      reason: "x",
    } as any)).toThrow(/deliberationId is required/);
    expect(() => deliberationOverrideHandler({
      deliberationId: d.id,
      decision: "bogus" as any,
      reason: "x",
    })).toThrow(/invalid decision/);
    expect(() => deliberationOverrideHandler({
      deliberationId: d.id,
      decision: "approve",
      reason: "",
    })).toThrow(/reason is required/);
  });
});
