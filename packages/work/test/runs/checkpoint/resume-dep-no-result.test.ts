// Focused test for an untested branch in buildResumeContext():
//
//   if (dep && dep.result) { ... }     ← dep IS found but result is falsy
//
// When a dependency IS matched by agentId/profileId but its `result` is
// null, undefined, or empty string, the `if (dep && dep.result)` guard
// suppresses the push.  contextParts stays empty, so the second guard
// (`if (contextParts.length === 0 && checkpoint.completedAgents?.length > 0)`)
// fires and includes ALL completed agents that do have a result.
//
// None of the existing resume tests cover this path — they only test the case
// where the dep lookup itself returns undefined (no match at all).

import { describe, it, expect } from "vitest";
import { buildResumeContext } from "@zana-ai/work/src/runs/checkpoint/resume.ts";

describe("buildResumeContext() — dependency matched but result is falsy", () => {
  it("falls through to all-agents context when the matched dep has a null result", () => {
    // agent-1 is matched by agentId but its result is null → guard skips it.
    // agent-2 is not a listed dependency but has a result → should appear via fallback.
    const checkpoint = {
      completedAgents: [
        { agentId: "agent-1", result: null },
        { agentId: "agent-2", result: "fallback output" },
      ],
    };
    const pendingAgent = { dependencies: ["agent-1"] };

    const ctx = buildResumeContext(checkpoint, pendingAgent);

    // Fallback path fires — agent-2's output should be included.
    expect(ctx).toContain("fallback output");
    // The context header must appear (non-empty context).
    expect(ctx).toMatch(/^Context from prior steps:/);
  });

  it("falls through to all-agents context when the matched dep has an empty-string result", () => {
    const checkpoint = {
      completedAgents: [
        { agentId: "dep-empty", profileId: "researcher", result: "" },
        { agentId: "other-agent", result: "other result" },
      ],
    };
    const pendingAgent = { dependencies: ["dep-empty"] };

    const ctx = buildResumeContext(checkpoint, pendingAgent);

    expect(ctx).toContain("other result");
    expect(ctx).toMatch(/^Context from prior steps:/);
  });

  it("returns empty string when the matched dep has no result and no other agent has a result", () => {
    // dep IS found, result is null.  Fallback iterates completed agents but none
    // have a truthy result → contextParts stays empty → "" is returned.
    const checkpoint = {
      completedAgents: [
        { agentId: "agent-x", result: null },
      ],
    };
    const pendingAgent = { dependencies: ["agent-x"] };

    const ctx = buildResumeContext(checkpoint, pendingAgent);

    expect(ctx).toBe("");
  });
});
