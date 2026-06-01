import { describe, it, expect } from "vitest";
import * as taskRouter from "@zana-ai/intelligence/src/intelligence/task-router.ts";
import * as profileStore from "@zana-ai/core/src/agents/profile-store.ts";

/**
 * resolveVoters() — turns voter specs into concrete profileIds.
 *
 * Spec shapes:
 *   - "architect"                → ["architect"] (literal id)
 *   - { profileId: "architect" } → ["architect"]
 *   - { lens: "security" }       → all profiles whose .lens === "security"
 *
 * Order is preserved, results deduped.
 */

describe("resolveVoters", () => {
  it("resolves a literal string profileId", () => {
    const result = taskRouter.resolveVoters(["architect"]);
    expect(result).toEqual(["architect"]);
  });

  it("resolves a {profileId} object spec", () => {
    const result = taskRouter.resolveVoters([{ profileId: "architect" }]);
    expect(result).toEqual(["architect"]);
  });

  it("resolves a {lens} spec to all matching profileIds", () => {
    const result = taskRouter.resolveVoters([{ lens: "security" }]);
    // security-reviewer is the only profile with lens="security" today;
    // assert containment so adding more security-lensed profiles later
    // doesn't break this test.
    expect(result).toContain("security-reviewer");
    // Sanity-check: every returned id has lens="security".
    for (const id of result) {
      const p = profileStore.getProfile(id);
      expect(p.lens).toBe("security");
    }
  });

  it("resolves a {lens} spec for performance to performance-engineer", () => {
    const result = taskRouter.resolveVoters([{ lens: "performance" }]);
    expect(result).toContain("performance-engineer");
  });

  it("mixes spec shapes correctly", () => {
    const result = taskRouter.resolveVoters([
      "researcher",
      { lens: "security" },
      { profileId: "architect" },
    ]);
    expect(result[0]).toBe("researcher");
    expect(result).toContain("security-reviewer");
    expect(result).toContain("architect");
    // researcher precedes architect
    expect(result.indexOf("researcher")).toBeLessThan(result.indexOf("architect"));
  });

  it("dedupes overlapping specs (same id yielded twice)", () => {
    // architect has lens="architecture"; combining lens lookup with a literal
    // architect spec must produce a single occurrence.
    const result = taskRouter.resolveVoters([
      { lens: "architecture" },
      { profileId: "architect" },
    ]);
    const archCount = result.filter((id) => id === "architect").length;
    expect(archCount).toBe(1);
  });

  it("throws on an unknown literal profileId", () => {
    expect(() =>
      taskRouter.resolveVoters(["nonexistent-profile-xyz"]),
    ).toThrow(/unknown profileId/);
  });

  it("throws on an unknown {profileId} object", () => {
    expect(() =>
      taskRouter.resolveVoters([{ profileId: "nonexistent-profile-xyz" }]),
    ).toThrow(/unknown profileId/);
  });

  it("returns [] portion for a lens with no matches (does not throw)", () => {
    const result = taskRouter.resolveVoters([{ lens: "nonexistent-lens-xyz" }]);
    expect(result).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(taskRouter.resolveVoters([])).toEqual([]);
  });
});
