// buildTeamLeadDisallowedTools draws permits from TWO independent sources: the
// base profile's allowedTools and the per-team rules.orchestratorAllowedTools
// override. Existing tests isolate each source on its own. This test exercises
// BOTH at once for DIFFERENT restrict-base tools in a single call, asserting the
// two `continue` branches (manager.ts lines 103 and 104) compose correctly: the
// only restricted tool is the one neither source permits.
import { describe, it, expect } from "vitest";
import { buildTeamLeadDisallowedTools } from "@zana-ai/work/src/teams/manager.ts";

describe("buildTeamLeadDisallowedTools — combined allow sources", () => {
  it("honors profile.allowedTools and rules.orchestratorAllowedTools together", () => {
    const team = { name: "T", rules: { orchestratorAllowedTools: ["Write"] } };
    const profile = {
      id: "orchestrator",
      // Bash permitted by the profile; Write permitted by the team override;
      // Edit permitted by neither, so only Edit should be disallowed.
      allowedTools: ["Read", "Bash"],
      disallowedTools: [],
    };

    const result = buildTeamLeadDisallowedTools(team, profile);

    expect(result).toContain("Edit");
    expect(result).not.toContain("Bash"); // skipped via profile.allowedTools
    expect(result).not.toContain("Write"); // skipped via orchestratorAllowedTools
    // Edit is the sole addition; nothing else leaks in and there are no dupes.
    expect(result).toEqual(["Edit"]);
  });
});
