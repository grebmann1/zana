import { describe, it, expect } from "vitest";
import * as profileStore from "@zana/core/src/agents/profile-store.ts";

/**
 * Profile lens metadata + getProfilesByLens query.
 *
 * The `lens` field tags a profile with a domain perspective (security,
 * architecture, performance, …) so callers like the task router can resolve
 * voters by lens tag instead of hard-coding profileIds.
 */

const EXPECTED_LENS = [
  ["architect", "architecture"],
  ["security-reviewer", "security"],
  ["code-reviewer", "code-quality"],
  ["test-writer", "testing"],
  ["debugger", "debugging"],
  ["backend-dev", "backend"],
  ["frontend-dev", "frontend"],
  ["researcher", "research"],
  ["doc-generator", "docs"],
  ["ux-designer", "ux"],
] as const;

const COORDINATION_PROFILES_NO_LENS = [
  "orchestrator",
  "swarm-master",
  "swarm-orchestrator",
  "full-auto-coder",
];

describe("profile lens metadata", () => {
  for (const [profileId, expectedLens] of EXPECTED_LENS) {
    it(`profile '${profileId}' has lens '${expectedLens}'`, () => {
      const profile = profileStore.getProfile(profileId);
      expect(profile).not.toBeNull();
      expect(profile.lens).toBe(expectedLens);
    });
  }

  it("coordination/general-purpose profiles correctly LACK lens", () => {
    for (const id of COORDINATION_PROFILES_NO_LENS) {
      const profile = profileStore.getProfile(id);
      expect(profile, `profile '${id}' should exist`).not.toBeNull();
      expect(profile.lens, `profile '${id}' should not have a lens`).toBeUndefined();
    }
  });
});

describe("getProfilesByLens", () => {
  it("returns security-reviewer for lens='security'", () => {
    const matches = profileStore.getProfilesByLens("security");
    const ids = matches.map((p: any) => p.id);
    expect(ids).toContain("security-reviewer");
  });

  it("returns performance-engineer for lens='performance'", () => {
    const matches = profileStore.getProfilesByLens("performance");
    const ids = matches.map((p: any) => p.id);
    expect(ids).toContain("performance-engineer");
  });

  it("returns api-designer for lens='api-design'", () => {
    const matches = profileStore.getProfilesByLens("api-design");
    const ids = matches.map((p: any) => p.id);
    expect(ids).toContain("api-designer");
  });

  it("returns [] for an unknown lens", () => {
    const matches = profileStore.getProfilesByLens("nonexistent-lens-xyz");
    expect(matches).toEqual([]);
  });

  it("returns [] for an empty/falsy lens", () => {
    expect(profileStore.getProfilesByLens("")).toEqual([]);
  });
});

describe("new profiles load with full schema", () => {
  it("performance-engineer profile loads correctly", () => {
    const p = profileStore.getProfile("performance-engineer");
    expect(p).not.toBeNull();
    expect(p.id).toBe("performance-engineer");
    expect(p.displayName).toBe("Performance Engineer");
    expect(p.lens).toBe("performance");
    expect(p.model).toBeTruthy();
    expect(typeof p.systemPrompt).toBe("string");
    expect(p.systemPrompt.length).toBeGreaterThan(0);
  });

  it("api-designer profile loads correctly", () => {
    const p = profileStore.getProfile("api-designer");
    expect(p).not.toBeNull();
    expect(p.id).toBe("api-designer");
    expect(p.displayName).toBe("API Designer");
    expect(p.lens).toBe("api-design");
    expect(p.model).toBeTruthy();
    expect(typeof p.systemPrompt).toBe("string");
    expect(p.systemPrompt.length).toBeGreaterThan(0);
  });
});
