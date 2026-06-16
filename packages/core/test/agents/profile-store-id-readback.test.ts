// Read-back invariant for id sanitization in
// packages/core/src/agents/profile-store.ts.
//
// saveProfile() sanitizes the id ONLY to derive the on-disk filename
//   safeId = id.replace(/[^a-zA-Z0-9\-_]/g, "")
// It does NOT mutate profile.id, so the persisted JSON keeps the ORIGINAL id.
// listProfiles()/getProfile() resolve by the in-file id field, never by the
// filename. The sibling profile-store-id-sanitization.test.ts pins the on-disk
// path boundary (no traversal) and the deleteProfile round-trip, but never
// proves how getProfile reads such a profile back. This pins that invariant:
//   - getProfile(originalId)  -> resolves (matches the in-file id)
//   - getProfile(sanitizedId) -> null     (no profile carries the safe id)
// A regression that started writing the sanitized id into the file (or
// resolving by filename) would flip both expectations.
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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-store-readback-"));
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

describe("profile-store id sanitization read-back", () => {
  it("resolves by the original id, not the sanitized filename", () => {
    // Space and "!" are stripped for the filename but kept in the in-file id.
    const originalId = "my agent!";
    const sanitizedId = "myagent";

    const saved = profileStore.saveProfile({ id: originalId, displayName: "Spacey" } as any);
    // saveProfile does not rewrite the logical id.
    expect(saved.id).toBe(originalId);

    // The file lands under the sanitized name, and its content keeps the
    // original id verbatim.
    const filePath = path.join(profilesTestDir, `${sanitizedId}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(onDisk.id).toBe(originalId);

    // Retrieval is by the in-file id...
    const byOriginal = profileStore.getProfile(originalId);
    expect(byOriginal).not.toBeNull();
    expect(byOriginal.displayName).toBe("Spacey");

    // ...and the sanitized filename is NOT a valid lookup key.
    expect(profileStore.getProfile(sanitizedId)).toBeNull();
  });
});
