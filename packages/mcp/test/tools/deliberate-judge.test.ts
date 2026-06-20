// Auto-judge gate tests — covers the post-loop adjudication path that turns
// a non-high-risk ESCALATED deliberation into SETTLED via a stub judge.
//
// Touches three layers:
//   1. parseJudgeOutput / shouldJudge pure helpers (judge.ts)
//   2. adjudicateEscalation directly against a hand-rolled ESCALATED record
//   3. deliberateHandler with cap_exhausted + escalationStrategy="judge"

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";

const work = require("@zana-ai/work");
const checkpointStore = work.runs.checkpoint.store;
const delib = work.deliberation;

import {
  deliberateHandler,
  type DeliberateDeps,
} from "../../src/tools/deliberate.ts";
import {
  adjudicateEscalation,
  buildJudgePrompt,
  parseJudgeOutput,
  shouldJudge,
} from "../../src/tools/judge.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fakes (mirrors deliberate.test.ts but trimmed)
// ─────────────────────────────────────────────────────────────────────────────

function profileFor(id: string, model = "claude-opus") {
  return { id, displayName: id, model, description: `lens ${id}` };
}

function fakeProbe() {
  return async (profile: any) => ({
    ok: true,
    latencyMs: 1,
    failures: [],
    modelId: profile.model || "unknown",
    probeId: `probe-${profile.id}`,
    legs: [],
  });
}

function fakeAgentPair(
  script: Record<number, Record<string, { bit: "APPROVE" | "CHANGES"; rationale: string }>>,
  state: { round: number },
) {
  let nextId = 0;
  const agents = new Map<string, any>();
  const spawnHeadlessAgent = (profile: any) => {
    const id = `fake-${profile.id}-${++nextId}`;
    const cell = script[state.round]?.[profile.id];
    const result = cell
      ? JSON.stringify({ bit: cell.bit, rationale: cell.rationale })
      : JSON.stringify({ bit: "CHANGES", rationale: "[no script]" });
    agents.set(id, { id, profileId: profile.id, state: "terminated", result, outputBuffer: result });
    return { agentId: id, terminalId: `term-${id}` };
  };
  return {
    spawnHeadlessAgent,
    getAgent: (id: string) => agents.get(id) ?? null,
    killAgent: (id: string) => agents.delete(id),
  };
}

function makeDeps(
  script: Record<number, Record<string, { bit: "APPROVE" | "CHANGES"; rationale: string }>>,
  state: { round: number },
  judgeOutput?: string,
): DeliberateDeps {
  const pair = fakeAgentPair(script, state);
  const profileMap = new Map<string, any>();
  const getProfile = (id: string) => {
    if (!profileMap.has(id)) profileMap.set(id, profileFor(id));
    return profileMap.get(id);
  };
  const deps: any = {
    probeAgent: fakeProbe(),
    spawnHeadlessAgent: pair.spawnHeadlessAgent,
    getAgent: pair.getAgent,
    killAgent: pair.killAgent,
    getProfile,
    pollIntervalMs: 1,
    timeoutMs: 5000,
    maxIterations: 32,
  };
  if (judgeOutput !== undefined) {
    deps.spawnOneShot = async () => ({ output: judgeOutput, exitCode: 0 });
  }
  return deps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup — same workspace bootstrap as deliberate.test.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-judge — pure helpers", () => {
  it("parseJudgeOutput accepts approve|reject|rework with rationale", () => {
    expect(parseJudgeOutput("VERDICT: approve\nThe X argument was strongest."))
      .toEqual({ verdict: "approve", rationale: "The X argument was strongest." });
    expect(parseJudgeOutput("VERDICT: reject\nBlocker present.")?.verdict).toBe("reject");
    expect(parseJudgeOutput("VERDICT: rework\nQuestion is malformed.")?.verdict).toBe("rework");
  });

  it("parseJudgeOutput is case-insensitive on the verdict token", () => {
    expect(parseJudgeOutput("verdict: APPROVE\nok")?.verdict).toBe("approve");
  });

  it("parseJudgeOutput returns null on malformed output", () => {
    expect(parseJudgeOutput("")).toBeNull();
    expect(parseJudgeOutput("no verdict here")).toBeNull();
    expect(parseJudgeOutput("VERDICT: maybe\n...")).toBeNull();
  });

  it("parseJudgeOutput surfaces full output as rationale when no trailing text", () => {
    const r = parseJudgeOutput("VERDICT: approve");
    expect(r).not.toBeNull();
    expect(r!.rationale).toBe("VERDICT: approve");
  });

  it("shouldJudge gates on state, riskTag, and strategy", () => {
    const base = { state: "ESCALATED" as const, riskTag: "low" as const };
    expect(shouldJudge(base, "judge")).toBe(true);
    expect(shouldJudge(base, "hybrid")).toBe(true);
    expect(shouldJudge(base, "human")).toBe(false);
    expect(shouldJudge(base, undefined)).toBe(false);
    // High-risk always human-only.
    expect(shouldJudge({ state: "ESCALATED", riskTag: "high" }, "judge")).toBe(false);
    expect(shouldJudge({ state: "ESCALATED", riskTag: "high" }, "hybrid")).toBe(false);
    // Non-terminal-escalated states are no-op.
    expect(shouldJudge({ state: "SETTLED", riskTag: "low" }, "judge")).toBe(false);
    expect(shouldJudge({ state: "CONVERGING", riskTag: "low" }, "judge")).toBe(false);
  });

  it("buildJudgePrompt includes question, escalation reason, voters, dissent", () => {
    const d: any = {
      question: "Should we ship X?",
      escalationReason: "cap_exhausted",
      riskTag: "low",
      currentRound: 2,
      rounds: 2,
      quorum: 2,
      voters: [{}, {}, {}],
      votes: [],
      dissent: [],
    };
    const out = buildJudgePrompt(d, [
      { profileId: "architect", round: 1, bit: "APPROVE", text: "Looks good." },
      { profileId: "security-reviewer", round: 1, bit: "CHANGES", text: "Concern about Y." },
    ], [
      { profileId: "security-reviewer", round: 1, text: "Verbatim dissent text." },
    ]);
    expect(out).toContain("Should we ship X?");
    expect(out).toContain("cap_exhausted");
    expect(out).toContain("architect");
    expect(out).toContain("Looks good.");
    expect(out).toContain("Verbatim dissent text.");
    expect(out).toContain("VERDICT: approve");
  });
});

describe("auto-judge — end-to-end through deliberateHandler", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-judge-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
    // Reset runtime config — other suites may have flipped strategy.
    delib.resetRuntimeConfig();
    // Register a 'judge' profile so adjudicateEscalation can find it via the
    // injected getProfile resolver. Real flow loads judge.json; here we just
    // need *something* that resolves.
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    delib.resetRuntimeConfig();
  });

  it("cap_exhausted + escalationStrategy=judge → judge resolves to SETTLED with verdictSource=judge", async () => {
    // 2 round cap; both rounds split → cap_exhausted → judge runs.
    const state = { round: 1 };
    const script: Record<number, Record<string, any>> = {
      1: {
        a: { bit: "APPROVE", rationale: "yes" },
        b: { bit: "APPROVE", rationale: "yes" },
        c: { bit: "CHANGES", rationale: "concern about X" },
      },
      2: {
        a: { bit: "APPROVE", rationale: "still yes" },
        b: { bit: "APPROVE", rationale: "still yes" },
        c: { bit: "CHANGES", rationale: "still concerned" },
      },
    };
    const deps = makeDeps(script, state, "VERDICT: approve\nThe a/b argument was more consistent with the goal.");
    // Bump round after first batch of 3 spawns.
    const origSpawn = deps.spawnHeadlessAgent!;
    let calls = 0;
    deps.spawnHeadlessAgent = (profile: any, options: any) => {
      const r = origSpawn(profile, options);
      calls++;
      if (calls === 3) {
        Promise.resolve().then(() => { state.round = 2; });
      }
      return r;
    };

    const result = await deliberateHandler({
      wait: true,
      question: "Adopt X?",
      voters: ["a", "b", "c"],
      rounds: 2,
      escalationStrategy: "judge",
      deps,
    });

    expect(result._outcome).toBe("judged");
    expect(result.state).toBe("SETTLED");
    expect(result.verdictSource).toBe("judge");
    expect(result.override?.humanId).toMatch(/^judge:/);
    expect(result.override?.decision).toBe("approve");
    expect(result._judge?.verdict).toBe("approve");
  });

  it("riskTag=high + escalationStrategy=judge → still ESCALATED (judge skipped)", async () => {
    const state = { round: 1 };
    const script: Record<number, Record<string, any>> = {
      1: {
        a: { bit: "APPROVE", rationale: "ok" },
        b: { bit: "APPROVE", rationale: "ok" },
        c: { bit: "APPROVE", rationale: "ok" },
      },
    };
    const deps = makeDeps(script, state, "VERDICT: approve\nshouldn't run");

    const result = await deliberateHandler({
      wait: true,
      question: "high stakes",
      voters: ["a", "b", "c"],
      riskTag: "high",
      escalationStrategy: "judge",
      deps,
    });

    expect(result.state).toBe("ESCALATED");
    expect(result.escalationReason).toBe("risk_high");
    expect(result.verdictSource).toBeUndefined();
    expect(result._outcome).not.toBe("judged");
  });

  it("malformed judge output → deliberation stays ESCALATED with _judgeError", async () => {
    const state = { round: 1 };
    const script: Record<number, Record<string, any>> = {
      1: {
        a: { bit: "CHANGES", rationale: "no" },
        b: { bit: "CHANGES", rationale: "no" },
        c: { bit: "CHANGES", rationale: "no" },
      },
      2: {
        a: { bit: "CHANGES", rationale: "still no" },
        b: { bit: "CHANGES", rationale: "still no" },
        c: { bit: "CHANGES", rationale: "still no" },
      },
    };
    const deps = makeDeps(script, state, "I cannot decide.");
    const origSpawn = deps.spawnHeadlessAgent!;
    let calls = 0;
    deps.spawnHeadlessAgent = (profile: any, options: any) => {
      const r = origSpawn(profile, options);
      calls++;
      if (calls === 3) Promise.resolve().then(() => { state.round = 2; });
      return r;
    };

    const result = await deliberateHandler({
      wait: true,
      question: "Doomed.",
      voters: ["a", "b", "c"],
      rounds: 2,
      escalationStrategy: "judge",
      deps,
    });

    expect(result.state).toBe("ESCALATED");
    expect(result._judgeError).toBeTruthy();
    expect(result.verdictSource).toBeUndefined();
  });

  it("default strategy=human → ESCALATED stays ESCALATED, no judge call", async () => {
    let judgeCalled = false;
    const state = { round: 1 };
    const script: Record<number, Record<string, any>> = {
      1: {
        a: { bit: "CHANGES", rationale: "no" },
        b: { bit: "CHANGES", rationale: "no" },
        c: { bit: "CHANGES", rationale: "no" },
      },
      2: {
        a: { bit: "CHANGES", rationale: "no" },
        b: { bit: "CHANGES", rationale: "no" },
        c: { bit: "CHANGES", rationale: "no" },
      },
    };
    const deps = makeDeps(script, state);
    deps.spawnOneShot = async () => {
      judgeCalled = true;
      return { output: "VERDICT: approve\nshould not run", exitCode: 0 };
    };
    const origSpawn = deps.spawnHeadlessAgent!;
    let calls = 0;
    deps.spawnHeadlessAgent = (profile: any, options: any) => {
      const r = origSpawn(profile, options);
      calls++;
      if (calls === 3) Promise.resolve().then(() => { state.round = 2; });
      return r;
    };

    const result = await deliberateHandler({
      wait: true,
      question: "Doomed.",
      voters: ["a", "b", "c"],
      rounds: 2,
      // escalationStrategy omitted → default "human"
      deps,
    });

    expect(result.state).toBe("ESCALATED");
    expect(judgeCalled).toBe(false);
  });

  it("adjudicateEscalation throws (leaving state untouched) on an unknown deliberation id", async () => {
    // Guard rail: the loop only calls adjudicateEscalation after reaching a
    // terminal-escalation state, but the function defends its own contract.
    // A missing id resolves to null in loadDeliberation → it must throw rather
    // than spawn a judge against nothing. spawnOneShot must never be reached.
    let spawnCalled = false;
    await expect(
      adjudicateEscalation("delib-does-not-exist", {
        getProfile: () => profileFor("judge"),
        spawnOneShot: async () => {
          spawnCalled = true;
          return { output: "VERDICT: approve", exitCode: 0 };
        },
      }),
    ).rejects.toThrow(/not found/);
    expect(spawnCalled).toBe(false);
  });

  it("council-settled deliberation has verdictSource=council (not judge)", async () => {
    const state = { round: 1 };
    const script: Record<number, Record<string, any>> = {
      1: {
        a: { bit: "APPROVE", rationale: "yes" },
        b: { bit: "APPROVE", rationale: "yes" },
        c: { bit: "APPROVE", rationale: "yes" },
      },
    };
    const deps = makeDeps(script, state);

    const result = await deliberateHandler({
      wait: true,
      question: "Easy yes.",
      voters: ["a", "b", "c"],
      escalationStrategy: "judge",
      deps,
    });

    expect(result.state).toBe("SETTLED");
    expect(result.verdict).toBe("approve");
    expect(result.verdictSource).toBe("council");
  });
});
