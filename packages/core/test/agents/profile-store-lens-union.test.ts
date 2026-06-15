// Focused test for getProfilesByLens() spanning BOTH built-in and user sources
// in packages/core/src/agents/profile-store.ts.
//
// profile-lens.test.ts covers built-in personas in isolation, and
// profile-store-lens-user.test.ts covers user-saved profiles in isolation.
// Neither covers the combined case: when a user profile is saved with the same
// lens as a shipped persona, a single getProfilesByLens() call must return BOTH
// — the query is a union across every source, not just one.
//
// Isolation mirrors the sibling profile-store tests: PROFILES_DIR is derived at
// module-load time, so the HOME redirect happens in vi.hoisted() before any
// @zana-ai/* import. The built-in personas still resolve from the package's
// shipped profiles/ dir.

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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-lens-union-"));
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

describe("getProfilesByLens union across built-in and user sources", () => {
  it("returns BOTH the shipped persona and a user profile sharing lens='security'", () => {
    // Precondition: the built-in security-reviewer persona declares lens 'security'.
    const builtInMatches = profileStore.getProfilesByLens("security");
    expect(builtInMatches.some((p: any) => p.id === "security-reviewer" && p.builtIn === true)).toBe(true);

    // Add a user profile that shares the same lens.
    profileStore.saveProfile({ id: "user-security-extra", displayName: "Extra Sec", lens: "security" });

    const matches = profileStore.getProfilesByLens("security");
    const ids = matches.map((p: any) => p.id);

    // The union must contain both sources for the same lens.
    expect(ids).toContain("security-reviewer");
    expect(ids).toContain("user-security-extra");
    // Every returned profile genuinely carries the requested lens — no leakage.
    expect(matches.every((p: any) => p.lens === "security")).toBe(true);
    // builtIn flags are preserved per source within the same result set.
    const userHit = matches.find((p: any) => p.id === "user-security-extra");
    const shippedHit = matches.find((p: any) => p.id === "security-reviewer");
    expect(userHit.builtIn).toBe(false);
    expect(shippedHit.builtIn).toBe(true);
  });
});
