// Unit tests for packages/core/src/guardrails/index.ts
// Covers resolveGuardrails, waitForAgent, and spawnValidatedAgent — no real agents, no network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGuardrails, waitForAgent, spawnValidatedAgent } from "../../src/guardrails/index.ts";

// ---------------------------------------------------------------------------
// Fake agent manager builder
// ---------------------------------------------------------------------------
function makeAgentManager(
  states: Array<"running" | "terminated" | "errored">,
  result = "agent output",
) {
  let spawnCount = 0;
  const queue = [...states];
  return {
    spawnHeadlessAgent: vi.fn((_profile: unknown, _opts: unknown) => ({
      agentId: `fake-agent-${spawnCount++}`,
    })),
    getAgent: vi.fn((_id: string) => {
      const s = queue.shift();
      if (s === undefined) return null;
      return { state: s, result };
    }),
  };
}

describe("resolveGuardrails", () => {
  it("returns empty array for null input", () => {
    expect(resolveGuardrails(null)).toEqual([]);
  });

  it("returns empty array for undefined input", () => {
    expect(resolveGuardrails(undefined)).toEqual([]);
  });

  it("returns empty array for empty array input", () => {
    expect(resolveGuardrails([])).toEqual([]);
  });

  it("passes through an object that already has a validate function", () => {
    const custom = { id: "custom", validate: vi.fn(() => ({ pass: true })) };
    const result = resolveGuardrails([custom]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(custom);
  });

  it("resolves json-parse type to a guardrail with an id", () => {
    const result = resolveGuardrails([{ type: "json-parse" }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("json-parse");
    expect(typeof result[0].validate).toBe("function");
  });

  it("resolves json-schema type to a guardrail", () => {
    const result = resolveGuardrails([{ type: "json-schema", schema: null }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("json-schema");
    expect(typeof result[0].validate).toBe("function");
  });

  it("resolves no-secrets type to a guardrail", () => {
    const result = resolveGuardrails([{ type: "no-secrets" }]);
    expect(result).toHaveLength(1);
    expect(typeof result[0].validate).toBe("function");
  });

  it("resolves max-length type with default maxChars", () => {
    const result = resolveGuardrails([{ type: "max-length" }]);
    expect(result).toHaveLength(1);
    expect(typeof result[0].validate).toBe("function");
    // Should pass for a short string
    expect(result[0].validate("hello").pass).toBe(true);
  });

  it("resolves max-length type with custom maxChars", () => {
    const result = resolveGuardrails([{ type: "max-length", maxChars: 5 }]);
    expect(result).toHaveLength(1);
    expect(result[0].validate("hi").pass).toBe(true);
    expect(result[0].validate("toolongstring").pass).toBe(false);
  });

  it("resolves contains-pattern type to a guardrail", () => {
    const result = resolveGuardrails([{ type: "contains-pattern", pattern: "hello", description: "must say hello" }]);
    expect(result).toHaveLength(1);
    expect(typeof result[0].validate).toBe("function");
    expect(result[0].validate("hello world").pass).toBe(true);
    expect(result[0].validate("goodbye world").pass).toBe(false);
  });

  it("resolves file-exists type and passes config.path through to the guardrail", () => {
    // file-exists is the one builtin type the rest of this suite never exercises.
    // Verify resolveGuardrails maps it to the builtin (id + path-aware name) and
    // that the resolved guardrail validates against config.path relative to ctx.cwd.
    const result = resolveGuardrails([{ type: "file-exists", path: "report.md" }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("file-exists");
    expect(result[0].name).toContain("report.md");

    // Deterministic, no real network: resolve against a cwd where the file is absent.
    const absentDir = path.join(os.tmpdir(), "zana-guardrail-fileexists-absent");
    const check = result[0].validate("ignored output", { cwd: absentDir });
    expect(check.pass).toBe(false);
    expect(check.feedback).toContain("report.md");
  });

  it("filters out unknown guardrail types (returns empty array)", () => {
    const result = resolveGuardrails([{ type: "nonexistent-type" }]);
    expect(result).toEqual([]);
  });

  it("filters out plain objects with no type and no validate function", () => {
    const result = resolveGuardrails([{ someRandomKey: 42 }]);
    expect(result).toEqual([]);
  });

  it("handles a mixed array — valid entries kept, unknowns dropped", () => {
    const configs = [
      { type: "json-parse" },
      { type: "unknown-xyz" },
      { id: "inline", validate: () => ({ pass: true }) },
    ];
    const result = resolveGuardrails(configs);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("json-parse");
    expect(result[1].id).toBe("inline");
  });
});

// ---------------------------------------------------------------------------
// waitForAgent
// ---------------------------------------------------------------------------
describe("waitForAgent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves {success:false, exitCode:-1} when agent is not found", async () => {
    const mgr = { getAgent: vi.fn(() => null) };
    const p = waitForAgent(mgr, "missing");
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ success: false, exitCode: -1, output: null });
  });

  it("resolves {success:true, exitCode:0} when agent reaches 'terminated'", async () => {
    // first call returns 'running', second 'terminated'
    const mgr = makeAgentManager(["running", "terminated"], "done text");
    const p = waitForAgent(mgr, "a1");
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ success: true, exitCode: 0, output: "done text" });
  });

  it("resolves {success:false, exitCode:1} when agent reaches 'errored'", async () => {
    const mgr = makeAgentManager(["errored"], "");
    const p = waitForAgent(mgr, "a2");
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ success: false, exitCode: 1 });
  });
});

// ---------------------------------------------------------------------------
// spawnValidatedAgent
// ---------------------------------------------------------------------------
describe("spawnValidatedAgent — no guardrails", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("spawns once and returns result when guardrails list is empty", async () => {
    const mgr = makeAgentManager(["terminated"], "hello");
    const p = spawnValidatedAgent(mgr, { id: "p1" }, { prompt: "go" }, []);
    await vi.runAllTimersAsync();
    const res = await p;
    expect(mgr.spawnHeadlessAgent).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ attempts: 1, guardrailsPassed: true, output: "hello" });
  });
});

describe("spawnValidatedAgent — passing guardrail", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("succeeds on first attempt and reports guardrailsPassed:true", async () => {
    const alwaysPass = { id: "ok", maxRetries: 2, validate: () => ({ pass: true }) };
    const mgr = makeAgentManager(["terminated"], "good output");
    const p = spawnValidatedAgent(mgr, { id: "p2" }, { prompt: "go" }, [alwaysPass]);
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.guardrailsPassed).toBe(true);
    expect(res.attempts).toBe(1);
  });
});

describe("spawnValidatedAgent — failing guardrail", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries and reports failure after exhausting maxRetries", async () => {
    // DEFAULT_MAX_RETRIES=2 is a floor, so even with guard.maxRetries=1 the
    // effective cap is max(1,2)=2 → 3 total attempts (attempt 0, 1, 2).
    const alwaysFail = { id: "bad", maxRetries: 1, validate: () => ({ pass: false, feedback: "nope" }) };
    const mgr = makeAgentManager(["terminated", "terminated", "terminated"], "bad");
    const p = spawnValidatedAgent(mgr, { id: "p3" }, { prompt: "go" }, [alwaysFail]);
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.guardrailsPassed).toBe(false);
    expect(res.attempts).toBe(3);
    expect((res as any).failedGuardrail).toBe("bad");
    expect((res as any).error).toBe("nope");
  });

  it("returns immediately (no retry) when the agent itself errored", async () => {
    const alwaysFail = { id: "bad", maxRetries: 2, validate: () => ({ pass: false, feedback: "nope" }) };
    const mgr = makeAgentManager(["errored"]);
    const p = spawnValidatedAgent(mgr, { id: "p4" }, { prompt: "go" }, [alwaysFail]);
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.guardrailsPassed).toBe(false);
    expect((res as any).error).toMatch(/errored before guardrail/i);
    expect(mgr.spawnHeadlessAgent).toHaveBeenCalledTimes(1);
  });
});

describe("spawnValidatedAgent — multiple guardrails", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The whole suite only ever wires up a SINGLE guardrail, so the guard loop in
  // spawnValidatedAgent (index.ts lines 114-125) is never exercised with more
  // than one guard. That loop `break`s at the first failing guard and reports
  // THAT guard's id as failedGuardrail. This pins the short-circuit: with a
  // passing guard ordered before a failing guard before a never-reached guard,
  // (a) the failure is attributed to the middle guard's id, not the first; and
  // (b) the guard ordered AFTER the failure is never evaluated on any attempt.
  it("stops at the first failing guardrail and never evaluates later guards", async () => {
    const first = { id: "first-pass", maxRetries: 2, validate: vi.fn(() => ({ pass: true })) };
    const second = { id: "second-fail", maxRetries: 2, validate: vi.fn(() => ({ pass: false, feedback: "second says no" })) };
    const third = { id: "third-never", maxRetries: 2, validate: vi.fn(() => ({ pass: true })) };

    // DEFAULT_MAX_RETRIES=2 → 3 attempts total; supply a terminated state each.
    const mgr = makeAgentManager(["terminated", "terminated", "terminated"], "out");
    const p = spawnValidatedAgent(mgr, { id: "p6" }, { prompt: "go" }, [first, second, third]);
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res.guardrailsPassed).toBe(false);
    expect((res as any).failedGuardrail).toBe("second-fail");
    expect((res as any).error).toBe("second says no");
    expect(res.attempts).toBe(3);

    // First guard runs every attempt; failing guard runs every attempt; the
    // guard ordered after the failure is short-circuited and never called.
    expect(first.validate).toHaveBeenCalledTimes(3);
    expect(second.validate).toHaveBeenCalledTimes(3);
    expect(third.validate).not.toHaveBeenCalled();
  });
});

describe("spawnValidatedAgent — retry recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The core self-correction loop the existing suite leaves untested: a guard
  // that FAILS on attempt 0 then PASSES on attempt 1. Pins (a) the retry does
  // happen (two spawns), (b) the second spawn's prompt is augmented with the
  // validation feedback via buildRetryPrompt, (c) the final result reports the
  // recovered success with attempts=2, and (d) parsedOutput from the passing
  // check is surfaced on the result.
  it("recovers on a later attempt, augments the retry prompt, and surfaces parsedOutput", async () => {
    let calls = 0;
    const flaky = {
      id: "flaky",
      maxRetries: 2,
      validate: () => {
        calls++;
        return calls === 1
          ? { pass: false, feedback: "needs valid JSON" }
          : { pass: true, parsedOutput: { ok: true } };
      },
    };
    const mgr = makeAgentManager(["terminated", "terminated"], "agent output");
    const p = spawnValidatedAgent(mgr, { id: "p5" }, { prompt: "go" }, [flaky]);
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res.guardrailsPassed).toBe(true);
    expect(res.attempts).toBe(2);
    expect((res as any).parsedOutput).toEqual({ ok: true });

    // Two spawns total; the retry prompt carries the failure feedback.
    expect(mgr.spawnHeadlessAgent).toHaveBeenCalledTimes(2);
    const retryPrompt = mgr.spawnHeadlessAgent.mock.calls[1][1].prompt as string;
    expect(retryPrompt).toContain("go");
    expect(retryPrompt).toContain("VALIDATION FAILED (attempt 1)");
    expect(retryPrompt).toContain("needs valid JSON");
  });
});
