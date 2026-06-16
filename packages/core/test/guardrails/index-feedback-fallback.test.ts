// Focused test for spawnValidatedAgent's failure-message resolution.
//
// index.ts line 119 resolves the reported message via a three-way fallback:
//   feedback = check.feedback || check.error || "Validation failed"
// The sibling index.test.ts only ever returns a guard check with `feedback`
// set, so the `check.error` fallback and the final "Validation failed" default
// are otherwise unpinned — a regression dropping either rung would still pass
// the existing suite while surfacing an empty/wrong message to the caller (and
// into the augmented retry prompt). Deterministic: fake timers, fake manager,
// no real agents or network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnValidatedAgent } from "../../src/guardrails/index.ts";

function makeAgentManager(
  states: Array<"running" | "terminated" | "errored">,
  result = "agent output",
) {
  let spawnCount = 0;
  const queue = [...states];
  return {
    spawnHeadlessAgent: vi.fn(() => ({ agentId: `fake-agent-${spawnCount++}` })),
    getAgent: vi.fn(() => {
      const s = queue.shift();
      if (s === undefined) return null;
      return { state: s, result };
    }),
  };
}

describe("spawnValidatedAgent — failure-message fallback chain", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses check.error when the failing guard provides no feedback", async () => {
    // No `feedback`, but an `error` → that error must be reported and threaded
    // into the retry prompt.
    const guard = {
      id: "err-only",
      maxRetries: 0, // effective cap is max(0,2)=2 → 3 attempts
      validate: () => ({ pass: false, error: "schema mismatch" }),
    };
    const mgr = makeAgentManager(["terminated", "terminated", "terminated"]);
    const p = spawnValidatedAgent(mgr, { id: "p" }, { prompt: "go" }, [guard]);
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res.guardrailsPassed).toBe(false);
    expect((res as any).error).toBe("schema mismatch");
    // The retry prompt carries the resolved message, not feedback.
    const retryPrompt = mgr.spawnHeadlessAgent.mock.calls[1][1].prompt as string;
    expect(retryPrompt).toContain("schema mismatch");
  });

  it("defaults to 'Validation failed' when the guard supplies neither feedback nor error", async () => {
    const guard = {
      id: "silent",
      maxRetries: 2,
      validate: () => ({ pass: false }), // no feedback, no error
    };
    const mgr = makeAgentManager(["terminated", "terminated", "terminated"]);
    const p = spawnValidatedAgent(mgr, { id: "p" }, { prompt: "go" }, [guard]);
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res.guardrailsPassed).toBe(false);
    expect((res as any).error).toBe("Validation failed");
    const retryPrompt = mgr.spawnHeadlessAgent.mock.calls[1][1].prompt as string;
    expect(retryPrompt).toContain("Validation failed");
  });
});
