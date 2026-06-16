// Security/precedence test for getProfile() in
// packages/core/src/agents/profile-store.ts.
//
// listProfiles() pushes BUILT-IN personas first, then user-dir profiles, and
// getProfile() returns the FIRST match by id. So when a user profile is saved
// under the same id as a shipped built-in (e.g. "code-reviewer"), the built-in
// still wins resolution — a user profile cannot silently hijack a built-in
// persona's identity or loosen its tool sandbox. The sibling
// profile-store-builtin-resolution.test.ts proves built-ins load, and
// profile-store-lens-union.test.ts proves a same-LENS user profile unions in,
// but neither pins the same-ID collision: a user "code-reviewer" that grants
// Write/Edit must NOT be the one getProfile returns.
//
// Same HOME-redirect strategy as profile-store.test.ts: config.ts derives
// PROFILES_DIR from os.homedir() at module-load time, so the redirect must
// happen in vi.hoisted() before any @zana-ai/* import.

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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-store-collision-"));
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

describe("getProfile — built-in vs user id collision", () => {
  it("returns the built-in when a user profile reuses a built-in id (no sandbox hijack)", () => {
    // Sanity: the shipped built-in is read-only (Write/Edit disallowed).
    const original = profileStore.getProfile("code-reviewer");
    expect(original).not.toBeNull();
    expect(original.builtIn).toBe(true);
    expect(original.disallowedTools).toContain("Write");

    // A user saves a permissive profile under the SAME id, trying to override.
    profileStore.saveProfile({
      id: "code-reviewer",
      displayName: "Hijacked Reviewer",
      disallowedTools: [], // grants Write/Edit
    } as any);
    // The user file really landed on disk under the colliding id...
    expect(fs.existsSync(path.join(profilesTestDir, "code-reviewer.json"))).toBe(true);

    // ...but getProfile still resolves to the BUILT-IN (pushed first), so the
    // read-only sandbox is preserved — the user profile cannot hijack it.
    const resolved = profileStore.getProfile("code-reviewer");
    expect(resolved.builtIn).toBe(true);
    expect(resolved.displayName).not.toBe("Hijacked Reviewer");
    expect(resolved.disallowedTools).toContain("Write");
    expect(resolved.disallowedTools).toContain("Edit");

    // Both entries DO exist in the full listing (built-in + shadowed user),
    // proving resolution order — not a missing write — is what makes the
    // built-in win.
    const sameId = profileStore.listProfiles().filter((p: any) => p.id === "code-reviewer");
    expect(sameId.length).toBeGreaterThanOrEqual(2);
    expect(sameId.some((p: any) => p.builtIn === true)).toBe(true);
    expect(sameId.some((p: any) => p.builtIn === false && p.displayName === "Hijacked Reviewer")).toBe(true);
  });
});
