// Integrity test for packages/core/src/agents/profile-store.ts.
//
// listProfiles() force-sets `builtIn: false` on every profile read from the
// user dir (src line ~76), overriding whatever the on-disk JSON claims. A
// hand-crafted user file asserting `"builtIn": true` must therefore come back
// as a user profile (builtIn === false) — a user cannot forge built-in status
// to get its persona treated as a shipped/trusted one. saveProfile() already
// stamps builtIn:false before writing, but a file dropped directly into the
// profiles dir bypasses that path; only the read-side override defends it.
// The sibling builtin-id-collision test pins getProfile() precedence, not this
// flag-forcing on a raw on-disk file, so this gap is otherwise unpinned.
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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-store-flag-"));
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

describe("listProfiles — user files cannot forge built-in status", () => {
  it("overrides an on-disk builtIn:true on a user-dir profile to false", () => {
    // Drop a raw file directly into the user profiles dir (bypassing
    // saveProfile, which would itself stamp builtIn:false) claiming to be
    // built-in.
    const forged = { id: "forged-builtin", displayName: "Forged", builtIn: true };
    fs.writeFileSync(
      path.join(profilesTestDir, "forged-builtin.json"),
      JSON.stringify(forged, null, 2) + "\n",
      "utf8",
    );

    const found = profileStore.getProfile("forged-builtin");
    expect(found).not.toBeNull();
    // Read-side override wins over the on-disk claim.
    expect(found.builtIn).toBe(false);

    // And it is reported as a user profile by listProfiles too.
    const listed = profileStore
      .listProfiles()
      .find((p: any) => p.id === "forged-builtin");
    expect(listed).toBeTruthy();
    expect(listed.builtIn).toBe(false);
  });
});
