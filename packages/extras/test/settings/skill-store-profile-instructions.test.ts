// Tests for skill-store.getInstructionsForProfile — the per-profile scoping of
// instruction skills, which is not covered by skill-store.test.ts or
// skill-store-list.test.ts.
//
// Scoping contract (see getInstructionsForProfile):
//   • global skills (global !== false) are ALWAYS included, regardless of profile.
//   • non-global skills (global === false) are included ONLY when the profile's
//     skillIds lists their id.
// An unknown profileId resolves to a null profile (getProfile returns null),
// so its skillIds are empty — exercising the "non-global excluded" branch
// deterministically without writing any profile to disk.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Redirect SKILLS_DIR via a partial mock of @zana-ai/contracts (same approach as
// skill-store-list.test.ts): spread the real module so lazyRequire survives, and
// override only SKILLS_DIR.
const configMock = vi.hoisted(() => ({ SKILLS_DIR: "" }));
vi.mock("@zana-ai/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zana-ai/contracts")>();
  return { ...actual, get SKILLS_DIR() { return configMock.SKILLS_DIR; } };
});

import {
  saveSkill,
  getInstructionsForProfile,
} from "@zana-ai/extras/src/settings/skill-store.ts";

describe("skill-store — getInstructionsForProfile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-skill-profile-test-"));
    configMock.SKILLS_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // A profile id guaranteed not to exist on disk → getProfile() returns null →
  // profile.skillIds defaults to [].
  const UNKNOWN_PROFILE = "no-such-profile-c0ffee-deadbeef";

  it("includes a global instruction skill even for an unknown profile", () => {
    saveSkill({ name: "g", type: "instruction", content: "global body", global: true });
    const out = getInstructionsForProfile(UNKNOWN_PROFILE);
    expect(out).toContain("[g]: global body");
  });

  it("excludes a non-global skill that the profile does not list", () => {
    saveSkill({ name: "scoped", type: "instruction", content: "scoped body", global: false });
    const out = getInstructionsForProfile(UNKNOWN_PROFILE);
    expect(out.some((s) => s.startsWith("[scoped]:"))).toBe(false);
  });
});
