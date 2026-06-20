// Branch guard: buildTeamLeadDisallowedTools must NOT apply the Write/Edit/Bash
// restriction to the swarm-master profile. swarm-master delegates exclusively
// via the zana_swarm_spawn MCP tool (its prompt forbids direct coding), so the
// lead is intentionally left with its profile's tools untouched. This locks the
// early-return branch that the other disallow tests don't exercise — a
// regression that dropped the swarm-master check would silently strip its
// implementation tools while still passing every other suite.
import { describe, it, expect } from "vitest";
import { buildTeamLeadDisallowedTools } from "@zana-ai/work/src/teams/manager.ts";

describe("buildTeamLeadDisallowedTools — swarm-master exemption", () => {
  it("never adds Write/Edit/Bash for the swarm-master profile", () => {
    // No allowedTools and no team override: the generic path WOULD restrict all
    // three of Write/Edit/Bash. The swarm-master early return must skip that.
    const team = { name: "Swarm", rules: {} };
    const profile = {
      id: "swarm-master",
      allowedTools: [],
      disallowedTools: ["MultiEdit"],
    };

    const result = buildTeamLeadDisallowedTools(team, profile);

    // Only the profile's own disallowed entries survive — no restrict-base adds.
    expect(result).toEqual(["MultiEdit"]);
    expect(result).not.toContain("Write");
    expect(result).not.toContain("Edit");
    expect(result).not.toContain("Bash");
  });
});
