// Focused test for getProfilesByLens over USER-saved profiles.
//
// profile-lens.test.ts exercises getProfilesByLens against BUILT-IN personas
// only. This covers the complementary path: a profile written via saveProfile
// must also participate in lens queries, and must not leak into queries for a
// different lens. Isolation mirrors profile-store.test.ts — redirect HOME in
// vi.hoisted() so config.ts derives PROFILES_DIR from the tmpdir at load time.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const { fakeHome, origHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-lens-user-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import * as profileStore from "@zana-ai/core/src/agents/profile-store.ts";

const profilesTestDir = path.join(fakeHome, ".zana", "profiles");

beforeAll(() => {
  fs.mkdirSync(profilesTestDir, { recursive: true });
});

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe("getProfilesByLens over user-saved profiles", () => {
  it("returns a user profile whose lens matches and excludes non-matching ones", () => {
    // Use a bespoke lens value no built-in persona declares, so the assertion
    // is unambiguous regardless of which built-ins resolve.
    const lens = "user-defined-lens-xyz";
    profileStore.saveProfile({ id: "user-lensed", displayName: "Lensed", lens });
    profileStore.saveProfile({ id: "user-other-lens", displayName: "Other", lens: "some-other-lens" });
    profileStore.saveProfile({ id: "user-no-lens", displayName: "Bare" });

    const matches = profileStore.getProfilesByLens(lens);
    const ids = matches.map((p: any) => p.id);

    expect(ids).toContain("user-lensed");
    expect(ids).not.toContain("user-other-lens");
    expect(ids).not.toContain("user-no-lens");
    // Every returned profile genuinely carries the requested lens.
    expect(matches.every((p: any) => p.lens === lens)).toBe(true);
  });
});
