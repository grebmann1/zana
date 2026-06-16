// Focused test for the falsy-lens guard in getProfilesByLens()
// (packages/core/src/agents/profile-store.ts).
//
// The sibling lens tests (profile-lens, profile-store-lens-user,
// profile-store-lens-union) all exercise a *truthy* lens value. None covers the
// documented early-return invariant: `if (!lens) return [];`. A falsy lens
// (undefined / "" / null) must short-circuit to an empty array WITHOUT ever
// touching the profile sources — even though built-in personas exist on disk.
//
// Isolation mirrors the sibling profile-store tests: PROFILES_DIR is derived at
// module-load time, so the HOME redirect happens in vi.hoisted() before any
// @zana-ai/* import.

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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-lens-empty-"));
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

describe("getProfilesByLens with a falsy lens", () => {
  it("returns an empty array for undefined, empty string, and null", () => {
    // Sanity: built-in personas DO carry lenses, so a truthy query is non-empty.
    // This proves the empty results below come from the guard, not an empty store.
    expect(profileStore.getProfilesByLens("security").length).toBeGreaterThan(0);

    expect(profileStore.getProfilesByLens(undefined as any)).toEqual([]);
    expect(profileStore.getProfilesByLens("")).toEqual([]);
    expect(profileStore.getProfilesByLens(null as any)).toEqual([]);
  });
});
