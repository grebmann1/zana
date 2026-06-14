// Boundary test: buildTeamLeadDisallowedTools must tolerate a profile that
// omits allowedTools/disallowedTools entirely. Profiles loaded from the store
// are not guaranteed to define these arrays, and the `|| []` fallbacks on both
// fields (manager.ts) are otherwise unexercised — every other test supplies
// both arrays. Regressing the fallbacks would throw on `new Set(undefined)`.
import { describe, it, expect } from "vitest";
import { buildTeamLeadDisallowedTools } from "@zana-ai/work/src/teams/manager.ts";

describe("buildTeamLeadDisallowedTools — profile without tool arrays", () => {
  it("does not throw and restricts Write/Edit/Bash when both fields are undefined", () => {
    const team = { name: "T", rules: {} };
    // No allowedTools, no disallowedTools — both rely on the `|| []` fallback.
    const profile = { id: "orchestrator" } as any;

    let result: string[];
    expect(() => {
      result = buildTeamLeadDisallowedTools(team, profile);
    }).not.toThrow();

    // Nothing is allowed, so all three implementation tools get restricted.
    expect(result!).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    // No duplicates — the claude CLI rejects repeated --disallowed-tools entries.
    expect(new Set(result!).size).toBe(result!.length);
  });
});
