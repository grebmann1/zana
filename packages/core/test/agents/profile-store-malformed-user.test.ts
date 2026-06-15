// Resilience test for listProfiles() in packages/core/src/agents/profile-store.ts.
//
// A corrupt user profile (invalid JSON, or a stray non-.json file) must not
// crash the whole listing — listProfiles() should warn, skip the bad file,
// and still return the valid profiles. Same HOME-redirect strategy as
// profile-store.test.ts: config.ts derives PROFILES_DIR at module-load time,
// so the redirect happens in vi.hoisted() before any @zana-ai/* import.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-store-malformed-"));
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

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  // Clean user dir between tests so leftovers don't bleed across cases.
  for (const f of fs.readdirSync(profilesTestDir)) {
    fs.rmSync(path.join(profilesTestDir, f), { force: true });
  }
});

describe("listProfiles resilience to bad user-dir files", () => {
  it("skips a malformed user profile, warns, and still returns valid ones", () => {
    profileStore.saveProfile({ id: "valid-one", displayName: "Good" });
    fs.writeFileSync(path.join(profilesTestDir, "broken.json"), "{ not: valid json", "utf8");

    let profiles: any[] = [];
    expect(() => {
      profiles = profileStore.listProfiles();
    }).not.toThrow();

    const userProfiles = profiles.filter((p) => !p.builtIn);
    expect(userProfiles.some((p) => p.id === "valid-one")).toBe(true);
    expect(userProfiles.some((p) => p.id === "broken")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to load user profile broken.json"),
      expect.anything(),
    );
  });

  it("ignores non-.json files in the user profiles directory", () => {
    profileStore.saveProfile({ id: "json-only", displayName: "Keep" });
    fs.writeFileSync(path.join(profilesTestDir, "README.txt"), "not a profile", "utf8");

    const profiles = profileStore.listProfiles();
    const userProfiles = profiles.filter((p) => !p.builtIn);
    expect(userProfiles.some((p) => p.id === "json-only")).toBe(true);
    // The stray .txt must not surface as a profile and must not warn.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("README"),
      expect.anything(),
    );
  });
});
