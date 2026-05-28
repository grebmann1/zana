// collect-reviews unit tests — buildVoterPrompt shape, parseVoterOutput
// tolerance, and timeout/spawn-error fallback paths.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildVoterPrompt,
  parseVoterOutput,
  collectReviews,
  type VoterSpec,
  type CollectReviewsDeps,
} from "../../src/tools/collect-reviews.ts";

const voter = (overrides: Partial<VoterSpec> = {}): VoterSpec => ({
  agentId: "fake-agent",
  profileId: "architect",
  modelId: "claude-sonnet-4-6",
  profile: { id: "architect", displayName: "Architect", description: "system design lens" },
  ...overrides,
});

describe("buildVoterPrompt", () => {
  it("includes the shared snapshot, role lens, and JSON contract", () => {
    const p = buildVoterPrompt("# Question\nShould we ship?", voter());
    expect(p).toContain("Should we ship?");
    expect(p).toContain("## Your role");
    expect(p).toContain("Architect");
    expect(p).toContain("system design lens");
    expect(p).toContain("## Output contract");
    expect(p).toContain('"bit"');
    expect(p).toContain("APPROVE");
    expect(p).toContain("CHANGES");
  });

  it("includes worked APPROVE and CHANGES examples (helps Claude end with valid JSON)", () => {
    const p = buildVoterPrompt("Q", voter());
    // Both example shapes must be present so the model has a concrete pattern.
    expect(p).toMatch(/Example APPROVE vote/i);
    expect(p).toMatch(/Example CHANGES vote/i);
    // The examples include realistic-looking rationales so the model doesn't
    // copy a placeholder.
    expect(p).toMatch(/Anti-dropout-bias|Migration loses data/);
  });

  it("ends with a strong tail instruction", () => {
    const p = buildVoterPrompt("Q", voter());
    expect(p.trimEnd().endsWith("No further prose.")).toBe(true);
  });

  it("falls back to profileId when displayName is absent", () => {
    const p = buildVoterPrompt("Q", voter({ profile: { id: "x", description: undefined } }));
    expect(p).toContain("architect"); // profileId
  });

  it("omits description block when profile has no description", () => {
    const p = buildVoterPrompt("Q", voter({ profile: { id: "x", displayName: "X" } }));
    expect(p).toContain("X");
    expect(p).not.toContain("undefined");
  });
});

describe("parseVoterOutput", () => {
  it("parses bare JSON", () => {
    const r = parseVoterOutput('{"bit":"APPROVE","rationale":"looks good"}');
    expect(r).toEqual({ bit: "APPROVE", rationale: "looks good" });
  });

  it("parses fenced JSON", () => {
    const r = parseVoterOutput('Some prose.\n```json\n{"bit":"CHANGES","rationale":"fix X"}\n```');
    expect(r).toEqual({ bit: "CHANGES", rationale: "fix X" });
  });

  it("parses JSON embedded in surrounding prose", () => {
    const r = parseVoterOutput("My take: {\"bit\":\"APPROVE\",\"rationale\":\"good\"} that's it.");
    expect(r.bit).toBe("APPROVE");
  });

  it("normalizes lowercase bit", () => {
    const r = parseVoterOutput('{"bit":"approve","rationale":"r"}');
    expect(r.bit).toBe("APPROVE");
  });

  it("falls back to CHANGES on empty input", () => {
    const r = parseVoterOutput("");
    expect(r.bit).toBe("CHANGES");
    expect(r.rationale).toMatch(/no output/i);
  });

  it("falls back to CHANGES with raw output preserved on parse failure", () => {
    const r = parseVoterOutput("just prose, no JSON");
    expect(r.bit).toBe("CHANGES");
    expect(r.rationale).toContain("just prose, no JSON");
  });

  it("falls back to CHANGES when bit is invalid", () => {
    const r = parseVoterOutput('{"bit":"MAYBE","rationale":"r"}');
    expect(r.bit).toBe("CHANGES");
  });

  it("provides default rationale text when rationale is empty", () => {
    const r = parseVoterOutput('{"bit":"APPROVE","rationale":""}');
    expect(r.bit).toBe("APPROVE");
    expect(r.rationale).toContain("no rationale");
  });

  it("handles null/undefined input", () => {
    expect(parseVoterOutput(null).bit).toBe("CHANGES");
    expect(parseVoterOutput(undefined).bit).toBe("CHANGES");
  });
});

describe("collectReviews — failure fallbacks", () => {
  it("spawn error → CHANGES vote with [spawn-error] rationale, never throws", async () => {
    const deps: CollectReviewsDeps = {
      spawnHeadlessAgent: () => { throw new Error("simulated spawn failure"); },
      getAgent: () => null,
      killAgent: () => true,
      storeContentAddressed: (b) => ({ hash: `sha256:${"a".repeat(64)}` }),
    };
    const reviews = await collectReviews(
      { round: 1, promptSnapshot: "Q", voters: [voter()] },
      deps,
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].bit).toBe("CHANGES");
    expect(reviews[0].rationale).toContain("[spawn-error]");
    expect(reviews[0].rationale).toContain("simulated spawn failure");
  });

  it("agent timeout → CHANGES vote with [timeout] rationale, killAgent called", async () => {
    let killed = false;
    const agents = new Map<string, any>();
    const deps: CollectReviewsDeps = {
      spawnHeadlessAgent: (_p, _o) => {
        const id = "a1";
        agents.set(id, { id, state: "running", outputBuffer: "" });
        return { agentId: id };
      },
      getAgent: (id) => agents.get(id) ?? null,
      killAgent: (id) => { killed = true; agents.delete(id); return true; },
      storeContentAddressed: () => ({ hash: `sha256:${"b".repeat(64)}` }),
      timeoutMs: 50,
      pollIntervalMs: 10,
    };
    const reviews = await collectReviews(
      { round: 1, promptSnapshot: "Q", voters: [voter()] },
      deps,
    );
    expect(reviews[0].bit).toBe("CHANGES");
    expect(reviews[0].rationale).toMatch(/\[timeout\]/);
    expect(killed).toBe(true);
  });

  it("returns one review per voter regardless of mixed success/failure", async () => {
    const agents = new Map<string, any>();
    let nextId = 0;
    const deps: CollectReviewsDeps = {
      spawnHeadlessAgent: (profile) => {
        if (profile.id === "fail") throw new Error("nope");
        const id = `agent-${++nextId}`;
        agents.set(id, {
          id, state: "terminated",
          result: '{"bit":"APPROVE","rationale":"ok"}',
          outputBuffer: '{"bit":"APPROVE","rationale":"ok"}',
        });
        return { agentId: id };
      },
      getAgent: (id) => agents.get(id) ?? null,
      killAgent: () => true,
      storeContentAddressed: () => ({ hash: `sha256:${"c".repeat(64)}` }),
      pollIntervalMs: 1,
    };
    const reviews = await collectReviews(
      {
        round: 1,
        promptSnapshot: "Q",
        voters: [
          voter({ profileId: "ok-1", profile: { id: "ok-1" } }),
          voter({ profileId: "fail",  profile: { id: "fail" } }),
          voter({ profileId: "ok-2", profile: { id: "ok-2" } }),
        ],
      },
      deps,
    );
    expect(reviews).toHaveLength(3);
    expect(reviews[0].bit).toBe("APPROVE");
    expect(reviews[1].bit).toBe("CHANGES"); // spawn-fail fallback
    expect(reviews[2].bit).toBe("APPROVE");
  });
});
