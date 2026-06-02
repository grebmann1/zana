// Team manager allowlist/disallowlist tests — guards against regressing the
// claude CLI conflict where Bash was both --allowed and --disallowed.
import { describe, it, expect } from "vitest";
import { buildTeamLeadDisallowedTools } from "@zana-ai/work/src/teams/manager.ts";

describe("buildTeamLeadDisallowedTools", () => {
  it("does not echo a tool the profile already allows into disallowed", () => {
    const team = { name: "T", rules: {} };
    const profile = {
      id: "orchestrator",
      allowedTools: ["Read", "Bash", "mcp__zana__*"],
      disallowedTools: ["Write", "Edit", "MultiEdit"],
    };
    const result = buildTeamLeadDisallowedTools(team, profile);
    expect(result).not.toContain("Bash");
    expect(result).toContain("Write");
    expect(result).toContain("Edit");
    expect(result).toContain("MultiEdit");
  });

  it("adds Write/Edit/Bash when profile permits none of them", () => {
    const team = { name: "T", rules: {} };
    const profile = {
      id: "researcher",
      allowedTools: ["Read", "Grep"],
      disallowedTools: [],
    };
    const result = buildTeamLeadDisallowedTools(team, profile);
    expect(result).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
  });

  it("respects team.rules.orchestratorAllowedTools as a per-team override", () => {
    const team = { name: "T", rules: { orchestratorAllowedTools: ["Bash"] } };
    const profile = { id: "orchestrator", allowedTools: ["Read"], disallowedTools: [] };
    const result = buildTeamLeadDisallowedTools(team, profile);
    expect(result).not.toContain("Bash");
    expect(result).toContain("Write");
    expect(result).toContain("Edit");
  });

  it("leaves swarm-master untouched", () => {
    const team = { name: "Swarm", rules: {} };
    const profile = { id: "swarm-master", allowedTools: [], disallowedTools: [] };
    expect(buildTeamLeadDisallowedTools(team, profile)).toEqual([]);
  });
});
