// Unit tests for the pure helpers in packages/mcp/src/tools/judge.ts.
//
// buildJudgePrompt, parseJudgeOutput, and shouldJudge are all pure value-in /
// value-out — no network, no Claude, no file I/O. The branches exercised here
// are NOT covered by deliberate-judge.test.ts, which focuses on the
// adjudicateEscalation / deliberateHandler integration paths.

import { describe, it, expect } from "vitest";
import {
  buildJudgePrompt,
  parseJudgeOutput,
  shouldJudge,
} from "../../src/tools/judge.ts";

// ─────────────────────────────────────────────────────────────────────────────
// buildJudgePrompt — edge cases
// ─────────────────────────────────────────────────────────────────────────────

function baseDeliberation(overrides: Record<string, unknown> = {}): any {
  return {
    question: "Should we refactor module X?",
    escalationReason: "cap_exhausted",
    riskTag: "low",
    currentRound: 3,
    rounds: 3,
    quorum: 2,
    voters: [{}, {}],
    votes: [],
    dissent: [],
    ...overrides,
  };
}

describe("buildJudgePrompt", () => {
  it("uses '(unspecified)' when escalationReason is undefined", () => {
    const d = baseDeliberation({ escalationReason: undefined });
    const out = buildJudgePrompt(d, [], []);
    expect(out).toContain("Escalation reason: (unspecified)");
  });

  it("uses '(none recorded)' when voterRationales is empty", () => {
    const out = buildJudgePrompt(baseDeliberation(), [], []);
    expect(out).toContain("(none recorded)");
    // The voter-rationales and dissent sections are independent; verify the
    // empty-voter placeholder does NOT bleed into the dissent section header.
    expect(out).toContain("## Voter rationales\n(none recorded)");
  });

  it("uses '(no dissent recorded)' when dissents is empty", () => {
    const out = buildJudgePrompt(baseDeliberation(), [], []);
    expect(out).toContain("(no dissent recorded)");
  });

  it("uses '(empty rationale)' for a voter whose text is an empty string", () => {
    const out = buildJudgePrompt(
      baseDeliberation(),
      [{ profileId: "reviewer", round: 1, bit: "APPROVE", text: "" }],
      [],
    );
    expect(out).toContain("(empty rationale)");
    expect(out).not.toContain("(none recorded)");
  });

  it("uses '(empty)' for a dissent entry whose text is an empty string", () => {
    const out = buildJudgePrompt(
      baseDeliberation(),
      [],
      [{ profileId: "reviewer", round: 1, text: "" }],
    );
    expect(out).toContain("(empty)");
    expect(out).not.toContain("(no dissent recorded)");
  });

  it("includes question, riskTag, rounds, quorum, and VERDICT instruction", () => {
    const d = baseDeliberation({ riskTag: "medium", quorum: 3, voters: [{}, {}, {}] });
    const out = buildJudgePrompt(d, [], []);
    expect(out).toContain("Should we refactor module X?");
    expect(out).toContain("Risk tag: medium");
    expect(out).toContain("Quorum: 3");
    expect(out).toContain("VERDICT: approve");
    expect(out).toContain("VERDICT: reject");
    expect(out).toContain("VERDICT: rework");
  });

  it("includes all voters and dissents when multiple are supplied", () => {
    const out = buildJudgePrompt(
      baseDeliberation(),
      [
        { profileId: "alice", round: 1, bit: "APPROVE", text: "Looks solid." },
        { profileId: "bob", round: 2, bit: "CHANGES", text: "Needs more work." },
      ],
      [
        { profileId: "bob", round: 2, text: "Specific concern about auth." },
      ],
    );
    expect(out).toContain("alice");
    expect(out).toContain("Looks solid.");
    expect(out).toContain("bob");
    expect(out).toContain("Needs more work.");
    expect(out).toContain("Specific concern about auth.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseJudgeOutput — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("parseJudgeOutput", () => {
  it("returns null for null input (non-string guard)", () => {
    // The function signature is (output: string) but callers can pass
    // arbitrary data; the runtime typeof guard must catch it.
    expect(parseJudgeOutput(null as unknown as string)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseJudgeOutput(undefined as unknown as string)).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseJudgeOutput("   \n\t  ")).toBeNull();
  });

  it("VERDICT token can appear mid-output with preamble before it", () => {
    const raw = "Some preamble.\nVERDICT: rework\nYou must address concern Z.";
    const r = parseJudgeOutput(raw);
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe("rework");
    expect(r!.rationale).toBe("You must address concern Z.");
  });

  it("falls back to the whole output as rationale when only the VERDICT line is present", () => {
    // Invariant (judge.ts): if nothing follows the VERDICT line, surface the
    // full output as rationale so the audit trail is never empty.
    const r = parseJudgeOutput("VERDICT: approve");
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe("approve");
    expect(r!.rationale).toBe("VERDICT: approve");
  });

  it("matches the VERDICT token case-insensitively and normalizes the verdict to lowercase", () => {
    // Invariant (judge.ts): the regex carries the /i flag and the captured
    // verdict is lowercased, so a model that emits mixed/upper case
    // ("Verdict: REWORK") still parses to the canonical lowercase token.
    const r = parseJudgeOutput("Verdict: REWORK\nPlease tighten the auth checks.");
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe("rework");
    expect(r!.rationale).toBe("Please tighten the auth checks.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldJudge — additional coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldJudge", () => {
  it("returns true for riskTag='medium' with strategy='judge'", () => {
    expect(shouldJudge({ state: "ESCALATED", riskTag: "medium" }, "judge")).toBe(true);
  });

  it("returns true for riskTag='medium' with strategy='hybrid'", () => {
    expect(shouldJudge({ state: "ESCALATED", riskTag: "medium" }, "hybrid")).toBe(true);
  });

  it("returns false for strategy='auto-judge' (unknown strategy)", () => {
    expect(shouldJudge({ state: "ESCALATED", riskTag: "low" }, "auto-judge")).toBe(false);
  });

  it("returns false when state is PROPOSED regardless of strategy", () => {
    expect(shouldJudge({ state: "PROPOSED", riskTag: "low" }, "judge")).toBe(false);
  });

  it("never auto-judges a high-risk deliberation even with a judge strategy", () => {
    // Safety invariant (judge.ts): high-risk escalations ALWAYS go to a human,
    // regardless of strategy. The riskTag='high' guard must short-circuit
    // before the strategy check for both judge-enabling strategies.
    expect(shouldJudge({ state: "ESCALATED", riskTag: "high" }, "judge")).toBe(false);
    expect(shouldJudge({ state: "ESCALATED", riskTag: "high" }, "hybrid")).toBe(false);
  });
});
