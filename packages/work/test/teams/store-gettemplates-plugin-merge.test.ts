// getTemplates() — plugin-contributed templates merge path.
//
// The existing store-seed-defaults test only covers the FALLBACK branch, where
// the plugin loader has no usable `getContributions` and getTemplates returns
// just the built-in TEAM_TEMPLATES. This test covers the SUCCESS branch: the
// loader returns `teamTemplates` contribution file paths, and getTemplates reads
// + appends the valid .json ones — while silently skipping paths that are
// non-.json or missing.
//
// @zana-ai/extras is externalized by vitest, so a whole-module vi.mock is
// bypassed by the runtime require() inside getTemplates. Instead we install a
// `getContributions` stub on the same cached loader instance the source sees,
// and restore it afterwards. No global ~/.zana writes — plugin files live in a
// temp dir.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getTemplates } from "@zana-ai/work/src/teams/store.ts";

const BASE = path.join(os.tmpdir(), `zana-test-gettemplates-${process.pid}`);
const PLUGIN_DIR = path.join(BASE, "plugin");
const validPluginFile = path.join(PLUGIN_DIR, "custom-team.json");
const missingFile = path.join(PLUGIN_DIR, "does-not-exist.json");
const nonJsonFile = path.join(PLUGIN_DIR, "notes.txt");

const PLUGIN_TEMPLATE = {
  name: "Plugin Contributed Squad",
  icon: "🔌",
  orchestratorProfileId: "orchestrator",
  slots: [{ profileId: "coder", quantity: 2 }],
};

// The same loader instance getTemplates reaches via require("@zana-ai/extras").
const loader = require("@zana-ai/extras").plugins.loader;
let originalGetContributions: any;

beforeAll(() => {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  fs.writeFileSync(validPluginFile, JSON.stringify(PLUGIN_TEMPLATE), "utf8");
  fs.writeFileSync(nonJsonFile, "not json", "utf8");
  // missingFile is intentionally never created.

  originalGetContributions = loader.getContributions;
  loader.getContributions = (kind: string) =>
    kind === "teamTemplates"
      ? [validPluginFile, missingFile, nonJsonFile]
      : [];
});

afterAll(() => {
  loader.getContributions = originalGetContributions;
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {}
});

describe("teams/store — getTemplates plugin merge", () => {
  it("appends a valid plugin-contributed .json template to the built-ins", () => {
    const templates = getTemplates();
    const match = templates.find((t: any) => t.name === PLUGIN_TEMPLATE.name);
    expect(match).toBeDefined();
    expect(match.icon).toBe("🔌");
    expect(match.slots).toEqual(PLUGIN_TEMPLATE.slots);
  });

  it("skips nonexistent and non-.json contribution paths (only one plugin entry merged)", () => {
    // Exactly one of the three contributed paths is a real .json file; the
    // nonexistent and non-.json paths are dropped by the filter, so the plugin
    // template appears exactly once regardless of the built-in count.
    const templates = getTemplates();
    const pluginEntries = templates.filter(
      (t: any) => t.name === PLUGIN_TEMPLATE.name,
    );
    expect(pluginEntries.length).toBe(1);
    // Built-ins are still present alongside the single merged plugin template.
    expect(templates.length).toBeGreaterThan(1);
  });

  it("never leaks raw file contents and yields well-formed template objects", () => {
    const templates = getTemplates();
    // The non-.json file's raw contents ("not json") must never appear.
    expect(templates.some((t: any) => t === "not json")).toBe(false);
    expect(templates.every((t: any) => t && typeof t.name === "string")).toBe(true);
  });
});
