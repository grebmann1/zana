// Regression test for incoherent headless-agent permissions (defect #2).
//
// The spawner injects a "TICKET LIFECYCLE" preamble that INSTRUCTS managed
// worker/reviewer profiles to call zana_ticket_claim / _complete /
// _update_status / _comment (and reviewers, _verdict). But an explicit
// `allowedTools` list RESTRICTS the agent to exactly those tools — so if the
// lifecycle tools aren't in the allowlist, the instructed calls fail and the
// worker falls back to faking the lifecycle via a different tool, misattributing
// the audit trail. (Observed: workers couldn't claim, so they used
// zana_ticket_update; reviewers couldn't call _verdict, so they emitted a text
// VERDICT line.)
//
// The fix makes buildClaudeArgs the single source of truth: wherever it injects
// the lifecycle preamble, it also augments --allowed-tools with the matching
// capability. This test pins instruction ⊇ capability so the two can't drift.

import { describe, it, expect } from "vitest";
import { buildClaudeArgs } from "@zana-ai/core/src/agents/spawner.ts";

const LIFECYCLE_TOOLS = [
  "mcp__zana__zana_ticket_claim",
  "mcp__zana__zana_ticket_complete",
  "mcp__zana__zana_ticket_update_status",
  "mcp__zana__zana_ticket_comment",
  "mcp__zana__zana_ticket_verdict",
];

function allowedToolsArg(args: string[]): string[] {
  const idx = args.indexOf("--allowed-tools");
  if (idx < 0) return [];
  // --allowed-tools is followed by a variadic list of tool names; collect until
  // the next flag.
  const out: string[] = [];
  for (let i = idx + 1; i < args.length && !args[i].startsWith("--"); i++) out.push(args[i]);
  return out;
}

describe("buildClaudeArgs — ticket-lifecycle allowlist coherence", () => {
  it("adds the lifecycle MCP tools to a restricted worker allowlist", () => {
    const profile = {
      id: "backend-dev",
      allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "TodoWrite"],
    };
    const allowed = allowedToolsArg(buildClaudeArgs(profile));
    for (const tool of LIFECYCLE_TOOLS) {
      expect(allowed).toContain(tool);
    }
    // Original tools are preserved.
    expect(allowed).toContain("Edit");
  });

  it("does not duplicate tools already granted by an mcp__zana__* wildcard", () => {
    const profile = {
      id: "some-worker",
      allowedTools: ["Read", "Bash", "mcp__zana__*"],
    };
    const allowed = allowedToolsArg(buildClaudeArgs(profile));
    // Wildcard already grants the lifecycle tools — they must not be appended.
    expect(allowed).not.toContain("mcp__zana__zana_ticket_claim");
    expect(allowed.filter((t) => t === "mcp__zana__*")).toHaveLength(1);
  });

  it("skips orchestrator-shaped profiles (they carry the full workflow already)", () => {
    const profile = {
      id: "orchestrator",
      allowedTools: ["Read", "Bash", "mcp__zana__*"],
    };
    const allowed = allowedToolsArg(buildClaudeArgs(profile));
    expect(allowed).toEqual(["Read", "Bash", "mcp__zana__*"]);
  });

  it("never re-adds a tool the profile explicitly disallowed", () => {
    const profile = {
      id: "restricted-reviewer",
      allowedTools: ["Read", "Grep", "Bash"],
      disallowedTools: ["mcp__zana__zana_ticket_complete"],
    };
    const allowed = allowedToolsArg(buildClaudeArgs(profile));
    expect(allowed).not.toContain("mcp__zana__zana_ticket_complete");
    // But the non-disallowed lifecycle tools are still added.
    expect(allowed).toContain("mcp__zana__zana_ticket_claim");
  });

  it("leaves an unrestricted profile (no allowlist) untouched — it can already call everything", () => {
    const args = buildClaudeArgs({ id: "open-worker" });
    expect(args).not.toContain("--allowed-tools");
  });
});
