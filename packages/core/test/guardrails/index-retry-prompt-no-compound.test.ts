// Focused regression test for spawnValidatedAgent's retry-prompt construction
// ACROSS MULTIPLE retries.
//
// index.ts line 138 rebuilds each retry prompt from `originalPrompt` (captured
// once at line 83), NOT from the already-augmented `options.prompt`. The
// invariant: feedback does NOT compound — the Nth retry prompt carries ONLY the
// (N-1)th attempt's feedback and "(attempt N)" header, never the prior round's.
//
// The existing suite only ever inspects the FIRST retry prompt (spawn call[1]),
// so a regression swapping `originalPrompt` -> `options.prompt` would silently
// compound stale feedback on the 2nd+ retry and still pass every other test.
// Deterministic: fake timers, fake manager, no real agents or network.

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

describe("spawnValidatedAgent — retry prompt does not compound feedback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rebuilds the 2nd retry prompt from the original prompt with only the latest feedback", async () => {
    let calls = 0;
    // Fails on attempt 0 (feedback "fb-zero") and attempt 1 (feedback "fb-one"),
    // forcing a third spawn whose prompt is the 2nd retry prompt.
    const guard = {
      id: "twice-failing",
      maxRetries: 2, // effective cap max(2,2)=2 -> attempts 0,1,2 (3 spawns)
      validate: () => {
        calls++;
        if (calls === 1) return { pass: false, feedback: "fb-zero" };
        if (calls === 2) return { pass: false, feedback: "fb-one" };
        return { pass: true };
      },
    };
    const mgr = makeAgentManager(["terminated", "terminated", "terminated"]);
    const p = spawnValidatedAgent(mgr, { id: "p" }, { prompt: "ORIGINAL_TASK" }, [guard]);
    await vi.runAllTimersAsync();
    await p;

    expect(mgr.spawnHeadlessAgent).toHaveBeenCalledTimes(3);

    const firstRetry = mgr.spawnHeadlessAgent.mock.calls[1][1].prompt as string;
    const secondRetry = mgr.spawnHeadlessAgent.mock.calls[2][1].prompt as string;

    // First retry: attempt-1 header + first feedback.
    expect(firstRetry).toContain("VALIDATION FAILED (attempt 1)");
    expect(firstRetry).toContain("fb-zero");

    // Second retry: built fresh from the ORIGINAL prompt, attempt-2 header, and
    // ONLY the latest feedback — no compounding of the prior round.
    expect(secondRetry).toContain("ORIGINAL_TASK");
    expect(secondRetry).toContain("VALIDATION FAILED (attempt 2)");
    expect(secondRetry).toContain("fb-one");
    expect(secondRetry).not.toContain("fb-zero");
    expect(secondRetry).not.toContain("(attempt 1)");
  });
});
