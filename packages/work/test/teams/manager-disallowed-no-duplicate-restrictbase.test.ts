// Regression guard: when a profile ALREADY lists one of the restrict-base tools
// (Write/Edit/Bash) in disallowedTools and the profile does not allow it, the
// tool is re-added by buildTeamLeadDisallowedTools. Because the output is built
// from a Set it must collapse to a single entry — the claude CLI rejects
// repeated --disallowed-tools entries (see manager.ts header). Other tests
// exercise this path but never assert the result is duplicate-free.
import { describe, it, expect } from "vitest";
import { buildTeamLeadDisallowedTools } from "@zana-ai/work/src/teams/manager.ts";

describe("buildTeamLeadDisallowedTools — no duplicate restrict-base tools", () => {
  it("does not duplicate a restrict-base tool already present in disallowedTools", () => {
    const team = { name: "T", rules: {} };
    const profile = {
      id: "orchestrator",
      // Write is already disallowed by the profile AND not allowed, so the
      // restrict-base loop will attempt to add it a second time.
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
    };

    const result = buildTeamLeadDisallowedTools(team, profile);

    // Write appears exactly once despite being both pre-listed and re-added.
    expect(result.filter((t) => t === "Write")).toEqual(["Write"]);
    // Edit/Bash still get restricted, and the whole list is duplicate-free.
    expect(result).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    expect(new Set(result).size).toBe(result.length);
  });
});
