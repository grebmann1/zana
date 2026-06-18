// Verifies the ticket-workflow instruction skill reaches a spawned agent's
// --append-system-prompt when its profile opts in via skillIds.
//
// buildClaudeArgs loads the REAL skillStore (its dynamic require isn't mocked in
// vitest — see build-claude-args.test.ts), so a profile carrying
// skillIds:["ticket-workflow"] pulls the committed built-in skill into the
// appended system prompt. This is the "personae are aware of the skill" wiring:
// without skillIds the guidance must NOT appear (global:false).

import { describe, it, expect } from "vitest";
import { buildClaudeArgs } from "@zana-ai/core/src/agents/spawner.ts";

function appendedPrompt(args: string[]): string {
  const i = args.indexOf("--append-system-prompt");
  return i >= 0 ? args[i + 1] : "";
}

describe("buildClaudeArgs — ticket-workflow skill injection", () => {
  it("injects the ticket-workflow guide for a profile that lists it in skillIds", () => {
    const profile = {
      id: "code-reviewer",
      displayName: "Code Reviewer",
      systemPrompt: "You review code.",
      skillIds: ["ticket-workflow"],
    };
    const appended = appendedPrompt(buildClaudeArgs(profile));
    expect(appended).toContain("ZANA SKILLS");
    expect(appended).toContain("TICKET WORKFLOW");
    expect(appended).toContain("zana_ticket_verdict");
    expect(appended).toContain("INCONCLUSIVE");
  });

  it("does NOT inject the ticket-workflow guide for a profile without the skillId", () => {
    // global:false means it only reaches opted-in profiles. Use a unique id so
    // no on-disk user profile/global skill can leak the content in.
    const profile = {
      id: "no-skill-profile-xyz",
      displayName: "Plain",
      systemPrompt: "You do a thing.",
    };
    const appended = appendedPrompt(buildClaudeArgs(profile));
    expect(appended).not.toContain("TICKET WORKFLOW");
    expect(appended).not.toContain("Working with Zana tickets");
  });
});
