/**
 * checkpoint/resume — unit tests for the pure helper functions.
 *
 * Covers:
 *   buildResumeContext()
 *     - returns "" when pendingAgent has no dependencies and no completedAgents
 *     - returns "" when listed dependencies have no matching completed agent
 *     - includes output only from the matching dependency, by agentId
 *     - includes output only from the matching dependency, by profileId
 *     - falls back to ALL completed agents when dependencies list is empty
 *     - uses profileName > profileId > agentId as the label, in that order
 *     - omits completed agents that have no result
 *
 *   enrichPrompt()
 *     - returns original prompt unchanged when context is falsy
 *     - appends context with a blank-line separator
 *
 * No file I/O, no agent manager, no real network.
 */

import { describe, it, expect } from "vitest";
import {
  buildResumeContext,
  enrichPrompt,
} from "@zana-ai/work/src/runs/checkpoint/resume.ts";

// ─── buildResumeContext ────────────────────────────────────────────────────────

describe("buildResumeContext()", () => {
  it("returns empty string when there are no completed agents and no dependencies", () => {
    const checkpoint = { completedAgents: [] };
    const pendingAgent = { dependencies: [] };
    expect(buildResumeContext(checkpoint, pendingAgent)).toBe("");
  });

  it("returns empty string when dependencies list is empty and completedAgents is absent", () => {
    const checkpoint = {};
    const pendingAgent = { dependencies: [] };
    expect(buildResumeContext(checkpoint, pendingAgent)).toBe("");
  });

  it("falls back to all completed agents when dependencies list specifies no matching agent", () => {
    // When dependencies are listed but none match a completed agent, contextParts
    // stays empty and the code falls through to include ALL completed agents as
    // context (better to over-share than to silently drop all context).
    const checkpoint = {
      completedAgents: [{ agentId: "agent-A", result: "result A" }],
    };
    const pendingAgent = { dependencies: ["agent-UNKNOWN"] };
    const ctx = buildResumeContext(checkpoint, pendingAgent);
    expect(ctx).toContain("result A");
  });

  it("includes output from matching dependency resolved by agentId", () => {
    const checkpoint = {
      completedAgents: [
        { agentId: "agent-1", profileId: "p1", result: "step 1 done" },
        { agentId: "agent-2", profileId: "p2", result: "step 2 done" },
      ],
    };
    const pendingAgent = { dependencies: ["agent-1"] };
    const ctx = buildResumeContext(checkpoint, pendingAgent);
    expect(ctx).toContain("step 1 done");
    expect(ctx).not.toContain("step 2 done");
  });

  it("includes output from matching dependency resolved by profileId", () => {
    const checkpoint = {
      completedAgents: [
        { agentId: "agent-99", profileId: "researcher", result: "research output" },
      ],
    };
    // dependency refers to the profileId rather than the agentId
    const pendingAgent = { dependencies: ["researcher"] };
    const ctx = buildResumeContext(checkpoint, pendingAgent);
    expect(ctx).toContain("research output");
  });

  it("falls back to all completed agents when dependencies list is absent", () => {
    const checkpoint = {
      completedAgents: [
        { agentId: "a1", result: "r1" },
        { agentId: "a2", result: "r2" },
      ],
    };
    const pendingAgent = {}; // no dependencies field
    const ctx = buildResumeContext(checkpoint, pendingAgent);
    expect(ctx).toContain("r1");
    expect(ctx).toContain("r2");
  });

  it("uses profileName as label when available", () => {
    const checkpoint = {
      completedAgents: [
        { agentId: "a1", profileId: "pid1", profileName: "Pretty Name", result: "out" },
      ],
    };
    const pendingAgent = { dependencies: ["a1"] };
    const ctx = buildResumeContext(checkpoint, pendingAgent);
    expect(ctx).toContain("Pretty Name");
    expect(ctx).not.toContain("pid1");
  });

  it("falls back to profileId when profileName is absent", () => {
    const checkpoint = {
      completedAgents: [{ agentId: "a1", profileId: "pid1", result: "out" }],
    };
    const pendingAgent = { dependencies: ["a1"] };
    const ctx = buildResumeContext(checkpoint, pendingAgent);
    expect(ctx).toContain("pid1");
  });

  it("falls back to agentId when both profileName and profileId are absent", () => {
    const checkpoint = {
      completedAgents: [{ agentId: "a1", result: "out" }],
    };
    const pendingAgent = { dependencies: ["a1"] };
    const ctx = buildResumeContext(checkpoint, pendingAgent);
    expect(ctx).toContain("a1");
  });

  it("omits completed agents that have no result (fallback path)", () => {
    const checkpoint = {
      completedAgents: [
        { agentId: "a1", result: "" },
        { agentId: "a2", result: "good output" },
      ],
    };
    const pendingAgent = {}; // fallback path
    const ctx = buildResumeContext(checkpoint, pendingAgent);
    expect(ctx).toContain("good output");
    // a1 had no result, so its label should NOT appear
    expect(ctx.match(/--- Output from/g)?.length ?? 0).toBe(1);
  });

  it("wraps each dependency block in separator markers", () => {
    const checkpoint = {
      completedAgents: [{ agentId: "a1", result: "hello" }],
    };
    const pendingAgent = { dependencies: ["a1"] };
    const ctx = buildResumeContext(checkpoint, pendingAgent);
    expect(ctx).toMatch(/^Context from prior steps:/);
    expect(ctx).toContain("--- Output from");
    expect(ctx).toContain("---");
  });
});

// ─── enrichPrompt ─────────────────────────────────────────────────────────────

describe("enrichPrompt()", () => {
  it("returns original prompt unchanged when context is empty string", () => {
    expect(enrichPrompt("do the thing", "")).toBe("do the thing");
  });

  it("returns original prompt unchanged when context is null", () => {
    expect(enrichPrompt("do the thing", null)).toBe("do the thing");
  });

  it("returns original prompt unchanged when context is undefined", () => {
    expect(enrichPrompt("do the thing", undefined)).toBe("do the thing");
  });

  it("appends context after a double newline separator", () => {
    const result = enrichPrompt("base prompt", "some context");
    expect(result).toBe("base prompt\n\nsome context");
  });

  it("handles empty original prompt with non-empty context", () => {
    const result = enrichPrompt("", "ctx");
    expect(result).toBe("\n\nctx");
  });
});
