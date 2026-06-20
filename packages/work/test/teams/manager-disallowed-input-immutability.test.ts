// Invariant guard: buildTeamLeadDisallowedTools must treat the baseProfile as
// read-only. Profiles are loaded once from the store and reused across every
// team-lead spawn, so mutating profile.disallowedTools/allowedTools (e.g. via
// .push instead of copying into a Set) would silently corrupt later spawns
// while still returning a correct value for the first call — passing every
// other test in this suite. This locks the no-mutation contract.
import { describe, it, expect } from "vitest";
import { buildTeamLeadDisallowedTools } from "@zana-ai/work/src/teams/manager.ts";

describe("buildTeamLeadDisallowedTools — does not mutate the input profile", () => {
  it("leaves baseProfile.disallowedTools and allowedTools untouched", () => {
    const team = { name: "T", rules: { orchestratorAllowedTools: ["Edit"] } };
    const profile = {
      id: "orchestrator",
      allowedTools: ["Read", "Bash"],
      disallowedTools: ["MultiEdit"],
    };
    const allowedSnapshot = [...profile.allowedTools];
    const disallowedSnapshot = [...profile.disallowedTools];

    const result = buildTeamLeadDisallowedTools(team, profile);

    // Result reflects the resolution: Bash allowed by profile, Edit allowed by
    // team override, Write restricted, MultiEdit preserved.
    expect(result).toContain("Write");
    expect(result).toContain("MultiEdit");
    expect(result).not.toContain("Bash");
    expect(result).not.toContain("Edit");

    // The input arrays must be byte-for-byte unchanged after the call.
    expect(profile.allowedTools).toEqual(allowedSnapshot);
    expect(profile.disallowedTools).toEqual(disallowedSnapshot);
  });
});
