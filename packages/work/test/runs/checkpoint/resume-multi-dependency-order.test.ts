// Focused test for an unasserted branch in buildResumeContext():
//
//   for (const depId of pendingAgent.dependencies) { ... }
//
// The function iterates the pendingAgent.dependencies array and emits one
// context block per MATCHED dependency. Every existing test uses a single
// dependency, so two behaviors are unpinned:
//   1. multiple matched dependencies each contribute a block, and
//   2. the blocks follow dependency-list order, NOT completedAgents order.
// A regression that iterated `completedAgents` instead would silently reorder
// (and could include unrelated agents). These tests lock the contract.
import { describe, it, expect } from "vitest";
import { buildResumeContext } from "@zana-ai/work/src/runs/checkpoint/resume.ts";

describe("buildResumeContext() — multiple dependencies", () => {
  it("emits one block per matched dependency, ordered by the dependencies list", () => {
    // completedAgents is in a DIFFERENT order than the dependencies list, so
    // the assertion can only pass if iteration follows dependencies, not
    // completedAgents.
    const checkpoint = {
      completedAgents: [
        { agentId: "agent-b", profileId: "pb", result: "B-out" },
        { agentId: "agent-a", profileId: "pa", result: "A-out" },
        { agentId: "agent-c", profileId: "pc", result: "C-out" },
      ],
    };
    const pendingAgent = { dependencies: ["agent-a", "agent-c"] };

    const ctx = buildResumeContext(checkpoint, pendingAgent);

    // Both matched deps appear; the unlisted agent-b does NOT.
    expect(ctx).toContain("A-out");
    expect(ctx).toContain("C-out");
    expect(ctx).not.toContain("B-out");

    // Exactly two blocks, in dependency-list order (A before C).
    expect(ctx.match(/--- Output from/g)?.length ?? 0).toBe(2);
    expect(ctx.indexOf("A-out")).toBeLessThan(ctx.indexOf("C-out"));
  });

  it("skips a listed dependency with no completed match while keeping the rest", () => {
    const checkpoint = {
      completedAgents: [
        { agentId: "agent-a", profileId: "pa", result: "A-out" },
        { agentId: "agent-c", profileId: "pc", result: "C-out" },
      ],
    };
    // "agent-missing" has no completed agent; it must be skipped, not throw,
    // and must not collapse into the all-agents fallback (real deps matched).
    const pendingAgent = { dependencies: ["agent-a", "agent-missing", "agent-c"] };

    const ctx = buildResumeContext(checkpoint, pendingAgent);

    expect(ctx.match(/--- Output from/g)?.length ?? 0).toBe(2);
    expect(ctx).toContain("A-out");
    expect(ctx).toContain("C-out");
    expect(ctx.indexOf("A-out")).toBeLessThan(ctx.indexOf("C-out"));
  });
});
