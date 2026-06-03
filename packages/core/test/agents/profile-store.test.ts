// Unit tests for packages/core/src/agents/profile-store.ts
//
// profile-lens.test.ts already covers built-in profile reads and getProfilesByLens.
// This file focuses on the mutable CRUD surface:
//   - saveProfile: persists to disk, auto-generates ID, sets timestamps
//   - deleteProfile: removes the file, returns correct boolean
//   - getProfile: round-trips through the user profile directory
//
// No real ~/.zana writes — PROFILES_DIR is redirected to a tmp directory.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── temp dir must be ready before vi.mock factory runs ──────────────────────
// vi.hoisted runs before any import is initialised — use require() here.
const { profilesTestDir, tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const tmpRoot = _fs.mkdtempSync(
    _path.join(_os.tmpdir(), "zana-profile-store-test-"),
  );
  return { profilesTestDir: _path.join(tmpRoot, "profiles"), tmpRoot };
});

// Redirect PROFILES_DIR so all writes stay in the temp directory.
vi.mock("@zana-ai/core/src/config.ts", () => ({
  PROFILES_DIR: profilesTestDir,
}));

import * as profileStore from "@zana-ai/core/src/agents/profile-store.ts";

// ── lifecycle ───────────────────────────────────────────────────────────────

beforeAll(() => {
  fs.mkdirSync(profilesTestDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── saveProfile ─────────────────────────────────────────────────────────────

describe("saveProfile", () => {
  it("writes the profile to disk and returns it", () => {
    const profile = { id: "test-save-01", displayName: "Tester" };
    const saved = profileStore.saveProfile(profile);

    const filePath = path.join(profilesTestDir, "test-save-01.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(onDisk.id).toBe("test-save-01");
    expect(onDisk.displayName).toBe("Tester");
    expect(saved.id).toBe("test-save-01");
  });

  it("auto-generates a UUID when the profile has no id", () => {
    const profile: any = { displayName: "Auto ID" };
    const saved = profileStore.saveProfile(profile);

    expect(typeof saved.id).toBe("string");
    expect(saved.id.length).toBeGreaterThan(0);
    // Verify file exists under the generated id
    const filePath = path.join(profilesTestDir, `${saved.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("always marks builtIn as false for user profiles", () => {
    const profile: any = { id: "test-builtin-false", builtIn: true };
    const saved = profileStore.saveProfile(profile);
    expect(saved.builtIn).toBe(false);
  });

  it("stamps createdAt on first save and updatedAt on every save", () => {
    const profile: any = { id: "test-timestamps" };
    const first = profileStore.saveProfile(profile);
    expect(typeof first.createdAt).toBe("string");
    expect(typeof first.updatedAt).toBe("string");

    // Second save preserves createdAt but refreshes updatedAt
    const second = profileStore.saveProfile({ ...first });
    expect(second.createdAt).toBe(first.createdAt);
    expect(typeof second.updatedAt).toBe("string");
  });

  it("throws on an id that sanitises to an empty string", () => {
    expect(() => profileStore.saveProfile({ id: "!!!" })).toThrow(
      /Invalid profile ID/,
    );
  });
});

// ── deleteProfile ───────────────────────────────────────────────────────────

describe("deleteProfile", () => {
  it("returns true and removes the file when the profile exists", () => {
    profileStore.saveProfile({ id: "to-delete" });
    const filePath = path.join(profilesTestDir, "to-delete.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const result = profileStore.deleteProfile("to-delete");
    expect(result).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("returns false when the profile does not exist", () => {
    const result = profileStore.deleteProfile("nonexistent-profile");
    expect(result).toBe(false);
  });

  it("throws on an id that sanitises to an empty string", () => {
    expect(() => profileStore.deleteProfile("@@@")).toThrow(
      /Invalid profile ID/,
    );
  });
});

// ── getProfile via user dir ──────────────────────────────────────────────────

describe("getProfile (user directory)", () => {
  it("returns the saved profile by id", () => {
    profileStore.saveProfile({ id: "get-by-id", displayName: "Find Me" });
    const found = profileStore.getProfile("get-by-id");
    expect(found).not.toBeNull();
    expect(found.displayName).toBe("Find Me");
  });

  it("returns null for an unknown id", () => {
    const found = profileStore.getProfile("totally-unknown-xyz");
    expect(found).toBeNull();
  });
});
