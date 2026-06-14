// Focused test for profile-store.profilesDir() — the only public accessor in
// profile-store.ts that lacked direct coverage.
//
// profilesDir() is the single source of truth for WHERE user profiles are
// written/read. The invariant under test: it returns exactly
// config.PROFILES_DIR (the global, host-scoped ~/.zana/profiles path), and
// saveProfile() persists into that very directory. If these ever drift,
// profiles would be written to one place and looked up in another.
//
// Strategy mirrors profile-store.test.ts: redirect HOME to a tmpdir inside
// vi.hoisted() BEFORE any @zana-ai/* module loads, because config.ts derives
// PROFILES_DIR from os.homedir() at module-load time.

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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-store-dir-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import * as profileStore from "@zana-ai/core/src/agents/profile-store.ts";
import config from "@zana-ai/core/src/config.ts";

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe("profile-store.profilesDir", () => {
  it("returns exactly config.PROFILES_DIR (the global host-scoped profiles path)", () => {
    expect(profileStore.profilesDir()).toBe(config.PROFILES_DIR);
  });

  it("resolves under the host ~/.zana directory, not a project-local path", () => {
    expect(profileStore.profilesDir()).toBe(path.join(fakeHome, ".zana", "profiles"));
  });

  it("is the directory saveProfile() actually writes into", () => {
    const saved = profileStore.saveProfile({ id: "dir-invariant-probe", name: "x" } as any);
    const written = path.join(profileStore.profilesDir(), `${saved.id}.json`);
    expect(fs.existsSync(written)).toBe(true);
    expect(path.dirname(written)).toBe(profileStore.profilesDir());
  });
});
