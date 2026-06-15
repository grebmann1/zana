// Security test for id sanitization in packages/core/src/agents/profile-store.ts.
//
// saveProfile()/deleteProfile() build the on-disk path from
//   safeId = id.replace(/[^a-zA-Z0-9\-_]/g, "")
// which strips '.' and '/' so a hostile id can never escape profilesDir via
// path traversal. The sibling profile-store.test.ts only pins the
// "sanitises to empty → throw" edge; it never proves that an id carrying
// "../" segments is reduced to a safe basename and written INSIDE profilesDir
// (not at the traversal target). This pins that boundary invariant — a
// regression that interpolated the raw id into the path (or loosened the
// regex) would let a write land outside ~/.zana/profiles.
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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-store-sanitize-"));
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

describe("profile-store id sanitization (path-traversal safety)", () => {
  it("strips path-traversal characters and writes strictly inside profilesDir", () => {
    // ".." and "/" are removed → "etcpasswd"; the file must NOT escape the dir.
    const saved = profileStore.saveProfile({ id: "../../../etc/passwd" } as any);

    const expectedPath = path.join(profilesTestDir, "etcpasswd.json");
    expect(fs.existsSync(expectedPath)).toBe(true);
    // The written file's directory is exactly profilesDir — no traversal.
    expect(path.dirname(expectedPath)).toBe(profilesTestDir);
    // Nothing leaked to the traversal target outside the profiles dir.
    expect(fs.existsSync(path.join(fakeHome, ".zana", "passwd.json"))).toBe(false);
    expect(fs.existsSync(path.join(fakeHome, "etc", "passwd.json"))).toBe(false);

    // saveProfile returns the profile; deleteProfile sanitizes the SAME way,
    // so the hostile id round-trips to the same safe file and removes it.
    expect(saved.id).toBe("../../../etc/passwd");
    expect(profileStore.deleteProfile("../../../etc/passwd")).toBe(true);
    expect(fs.existsSync(expectedPath)).toBe(false);
  });
});
