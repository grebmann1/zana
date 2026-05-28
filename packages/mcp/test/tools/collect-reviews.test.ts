// collect-reviews unit tests — buildVoterPrompt shape, parseVoterOutput
// tolerance, and timeout/spawn-error fallback paths.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildVoterPrompt,
  parseVoterOutput,
  collectReviews,
  extractAssistantTextFromStreamJson,
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
    // All three example archetypes must be present so the model has concrete
    // patterns to follow — confident APPROVE, concrete CHANGES, uncertainty CHANGES.
    expect(p).toMatch(/Confident APPROVE/i);
    expect(p).toMatch(/Confident CHANGES/i);
    expect(p).toMatch(/Uncertainty CHANGES/i);
    // The examples include realistic rationales so the model doesn't copy a placeholder.
    expect(p).toMatch(/anti-dropout-bias|migration loses data/i);
  });

  it("frames the role as a council member with a tight budget (anti-exploration)", () => {
    const p = buildVoterPrompt("Q", voter());
    // Time + tool-call budget must be stated up front so the model doesn't
    // default to comprehensive-audit mode.
    expect(p).toMatch(/5 minutes/i);
    expect(p).toMatch(/5 tool calls/i);
    expect(p).toMatch(/council member/i);
    // Explicit anti-pattern callout — recognizable failure mode.
    expect(p).toMatch(/more than ~5 files.*STOP/is);
  });

  it("legitimizes uncertainty as a first-class CHANGES vote", () => {
    const p = buildVoterPrompt("Q", voter());
    // Voters must know that "I'm not sure" is a CHANGES vote, not a failure.
    expect(p).toMatch(/uncertainty/i);
    expect(p).toMatch(/first-class/i);
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

  // Real-Claude regression — voters that emit the JSON vote then continue
  // speaking after a background tool result lands. The first valid JSON in
  // the transcript IS the canonical vote, but if any later acknowledgment
  // restates {bit, rationale}, the LAST is the voter's final word.
  it("returns the LAST valid {bit, rationale} when multiple appear (multi-turn)", () => {
    const raw = [
      "Initial vote:",
      "```json",
      '{"bit":"CHANGES","rationale":"need more context"}',
      "```",
      "After reviewing the file, my vote stands. Final answer:",
      "```json",
      '{"bit":"APPROVE","rationale":"context confirmed; concern resolved"}',
      "```",
    ].join("\n");
    const r = parseVoterOutput(raw);
    expect(r.bit).toBe("APPROVE");
    expect(r.rationale).toMatch(/concern resolved/);
  });

  it("finds the vote when prose follows the JSON block", () => {
    // The exact failure mode from the 3v2r real-Claude run: voter emits the
    // JSON vote, then a background tool callback fires and the voter
    // narrates the result. Both pieces of text get concatenated downstream.
    const raw = [
      "```json",
      '{"bit":"APPROVE","rationale":"governance guarantee favors rule-based"}',
      "```",
      "",
      "The background `find` completed with exit code 0 — no action needed.",
    ].join("\n");
    const r = parseVoterOutput(raw);
    expect(r.bit).toBe("APPROVE");
    expect(r.rationale).toMatch(/governance guarantee/);
  });
});

describe("extractAssistantTextFromStreamJson", () => {
  it("returns null for empty/non-stream-json buffers", () => {
    expect(extractAssistantTextFromStreamJson("")).toBeNull();
    expect(extractAssistantTextFromStreamJson(null)).toBeNull();
    expect(extractAssistantTextFromStreamJson("just plain prose, no JSON")).toBeNull();
  });

  it("concatenates assistant text blocks across multiple turns", () => {
    // Simulates what manager.ts feeds: stream-json lines, one per chunk.
    const buf = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "turn 1: vote" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "turn 2: ack" }] },
      }),
      JSON.stringify({ type: "result", result: "final summary" }),
    ].join("\n");
    const out = extractAssistantTextFromStreamJson(buf);
    expect(out).toContain("turn 1: vote");
    expect(out).toContain("turn 2: ack");
    expect(out).toContain("final summary");
  });

  it("ignores non-assistant message types (tool_use, system, etc.)", () => {
    const buf = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "user", message: { content: "user msg" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "the only text" }] },
      }),
    ].join("\n");
    const out = extractAssistantTextFromStreamJson(buf);
    expect(out).toBe("the only text");
  });

  it("tolerates non-JSON lines mixed into the buffer", () => {
    const buf = [
      "progress indicator that isn't JSON",
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "vote text" }] },
      }),
      "",
    ].join("\n");
    const out = extractAssistantTextFromStreamJson(buf);
    expect(out).toBe("vote text");
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

  it("recovers vote from outputBuffer when result holds only post-vote prose (multi-turn)", async () => {
    // Reproduces the 3v2r real-Claude regression: the voter cast the JSON
    // vote in turn 1, then a background tool result triggered a turn 2 with
    // narration only. manager.ts overwrites agent.result on each assistant
    // turn — so result="post-vote prose" while outputBuffer still holds the
    // full stream-json transcript with the JSON in turn 1.
    const buffer = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: '```json\n{"bit":"APPROVE","rationale":"rule-based wins on dissent guarantee"}\n```',
          }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: "Background find completed. No action needed.",
          }],
        },
      }),
    ].join("\n");

    const agents = new Map<string, any>();
    const deps: CollectReviewsDeps = {
      spawnHeadlessAgent: () => {
        const id = "voter-1";
        agents.set(id, {
          id,
          state: "terminated",
          // What got clobbered — the latest assistant text only.
          result: "Background find completed. No action needed.",
          // What survives — the full transcript.
          outputBuffer: buffer,
        });
        return { agentId: id };
      },
      getAgent: (id) => agents.get(id) ?? null,
      killAgent: () => true,
      storeContentAddressed: () => ({ hash: `sha256:${"d".repeat(64)}` }),
      pollIntervalMs: 1,
    };
    const reviews = await collectReviews(
      { round: 1, promptSnapshot: "Q", voters: [voter()] },
      deps,
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].bit).toBe("APPROVE");
    expect(reviews[0].rationale).toMatch(/dissent guarantee/);
    // The parse-fallback marker is the bug-shaped failure we are guarding against.
    expect(reviews[0].rationale).not.toMatch(/parse-fallback/);
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
