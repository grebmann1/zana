// listProfiles() — plugin-contributed profiles merge path.
//
// The sibling profile-store tests cover built-in resolution, user-dir loading,
// malformed/non-.json skipping, and the lens guards — but NONE exercises the
// plugin-contributed branch (profile-store.ts lines 84-102): the loader returns
// `profiles` contribution file paths, and listProfiles reads + appends the valid
// .json ones, stamping `_source: "plugin"` and `builtIn: false`, while silently
// skipping paths that are non-.json or missing.
//
// @zana-ai/extras is externalized by vitest, so a whole-module vi.mock is
// bypassed by the runtime require() inside listProfiles. Instead we install a
// `getContributions` stub on the same cached loader instance the source sees,
// and restore it afterwards (mirrors work/test/teams/store-gettemplates-plugin-
// merge.test.ts). HOME is redirected in vi.hoisted() so the user PROFILES_DIR is
// an empty temp dir and the plugin entry is the only non-built-in profile.

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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-profile-plugin-merge-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import * as profileStore from "@zana-ai/core/src/agents/profile-store.ts";

const profilesTestDir = path.join(fakeHome, ".zana", "profiles");

const PLUGIN_DIR = path.join(fakeHome, "plugin");
const validPluginFile = path.join(PLUGIN_DIR, "plugin-persona.json");
const missingFile = path.join(PLUGIN_DIR, "does-not-exist.json");
const nonJsonFile = path.join(PLUGIN_DIR, "notes.txt");

const PLUGIN_PROFILE = { id: "plugin-persona", displayName: "Plugin Persona", lens: "security" };

// The same loader instance listProfiles reaches via require("@zana-ai/extras").
const loader = require("@zana-ai/extras").plugins.loader;
let originalGetContributions: any;

beforeAll(() => {
  fs.mkdirSync(profilesTestDir, { recursive: true });
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  fs.writeFileSync(validPluginFile, JSON.stringify(PLUGIN_PROFILE), "utf8");
  fs.writeFileSync(nonJsonFile, "not json", "utf8");
  // missingFile is intentionally never created.

  originalGetContributions = loader.getContributions;
  loader.getContributions = (kind: string) =>
    kind === "profiles" ? [validPluginFile, missingFile, nonJsonFile] : [];
});

afterAll(() => {
  loader.getContributions = originalGetContributions;
  process.env.HOME = origHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe("listProfiles — plugin-contributed merge", () => {
  it("appends a valid plugin .json profile stamped _source=plugin and builtIn=false", () => {
    const match = profileStore.listProfiles().find((p: any) => p.id === PLUGIN_PROFILE.id);
    expect(match).toBeDefined();
    expect(match.displayName).toBe("Plugin Persona");
    expect(match._source).toBe("plugin");
    expect(match.builtIn).toBe(false);
  });

  it("skips nonexistent and non-.json contribution paths (plugin profile merged exactly once)", () => {
    // One of the three contributed paths is a real .json file; the missing and
    // non-.json paths are dropped by the filter, so the plugin profile appears
    // exactly once and its raw text never leaks in as a profile.
    const profiles = profileStore.listProfiles();
    expect(profiles.filter((p: any) => p.id === PLUGIN_PROFILE.id).length).toBe(1);
    expect(profiles.some((p: any) => p === "not json")).toBe(false);
  });

  it("makes the plugin profile resolvable by id and lens", () => {
    expect(profileStore.getProfile("plugin-persona")).not.toBeNull();
    expect(
      profileStore.getProfilesByLens("security").some((p: any) => p.id === "plugin-persona"),
    ).toBe(true);
  });
});
