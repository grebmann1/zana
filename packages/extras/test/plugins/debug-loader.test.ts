// Smoke test for the plugin loader running with relative imports through
// vitest's SSR runner. Mirrors the production loader.test.ts setup but is a
// minimal sanity check to catch resolver regressions early.
//
// Strategy: redirect HOME to a tmpdir before any @zana-ai/* module loads, so
// the REAL @zana-ai/core's `config.PLUGINS_DIR` resolves under that tmpdir.
// We then write one plugin manifest into a project-local scratch dir (Vite's
// SSR sandbox refuses requires from outside the project root).

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { fakeHome, origHome, scratchBase } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-debug-loader-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const here = _path.dirname(new URL(import.meta.url).pathname);
  const scratchBase = _path.join(here, ".scratch-debug");
  return { fakeHome, origHome, scratchBase };
});

import * as loader from "../../src/plugins/loader.ts";

let realCore: any;
let pluginsDir = "";

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  realCore = require("@zana-ai/core");
  fs.mkdirSync(scratchBase, { recursive: true });
  pluginsDir = fs.mkdtempSync(path.join(scratchBase, "zana-debug-"));
  require("@zana-ai/contracts/dist/src/config").PLUGINS_DIR = pluginsDir;
});

afterEach(() => {
  loader.unloadPlugins();
  try { fs.rmSync(pluginsDir, { recursive: true, force: true }); } catch {}
  try { fs.rmdirSync(scratchBase); } catch {}
});

afterAll(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

describe("debug loader", () => {
  it("PLUGINS_DIR is honoured for a single plugin loaded via relative import", () => {
    const pluginDir = path.join(pluginsDir, "alpha");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ id: "alpha", name: "Alpha", version: "1.0.0", main: "index.js" }),
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = {};");

    loader.loadPlugins();

    const list = loader.listPlugins();
    expect(list.find((p) => p.id === "alpha")).toBeDefined();
  });
});
