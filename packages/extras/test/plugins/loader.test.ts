// Integration test for packages/extras/src/plugins/loader.ts.
//
// Strategy: redirect HOME to a tmpdir before any @zana-ai/* module loads, so
// the REAL @zana-ai/core's `config.PLUGINS_DIR` resolves under that tmpdir.
// We then write plugin manifests into that dir and exercise the real loader.
// No internal modules are mocked.
//
// External boundaries that stay implicit (we don't exercise them):
//   - tickets/service routing inside loader (covered by work tests).
//   - eventBusService publish (best-effort; not strictly under test here).

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
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-loader-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  // SCRATCH_BASE must live under the project root so Vite's SSR module runner
  // can require() plugin index.js files (files outside the project root are
  // blocked).
  const here = _path.dirname(new URL(import.meta.url).pathname);
  const scratchBase = _path.join(here, ".scratch");
  return { fakeHome, origHome, scratchBase };
});

import * as loader from "../../src/plugins/loader.ts";

// The real @zana-ai/core picks up PLUGINS_DIR from os.homedir()/.zana/plugins.
// We override HOME → fakeHome but we ALSO need PLUGINS_DIR to point at a
// project-local scratch dir so the loader's runtime require() of plugin
// index.js files works under Vite's SSR sandbox.

let realCore: any;

function corePluginsDir(): string {
  return realCore.config.PLUGINS_DIR;
}

const tmpDirs: string[] = [];

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  realCore = require("@zana-ai/core");
  fs.mkdirSync(scratchBase, { recursive: true });
  // Each test gets a fresh tmp plugins dir under SCRATCH_BASE.
  const dir = fs.mkdtempSync(path.join(scratchBase, "loader-"));
  tmpDirs.push(dir);
  require("@zana-ai/contracts/dist/src/config").PLUGINS_DIR = dir;
});

afterEach(() => {
  loader.unloadPlugins();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  // tidy up scratch base if empty
  try { fs.rmdirSync(scratchBase); } catch {}
});

afterAll(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

function writePlugin(baseDir: string, id: string, extra: Record<string, unknown> = {}) {
  const pluginDir = path.join(baseDir, id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ id, name: `Plugin ${id}`, version: "1.0.0", main: "index.js", ...extra }),
  );
  fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = {};\n");
}

// ── loadPlugins ──────────────────────────────────────────────────────────────

describe("loadPlugins", () => {
  it("loads a valid plugin and makes it retrievable via getPlugin", () => {
    writePlugin(corePluginsDir(), "alpha");
    loader.loadPlugins();
    const p = loader.getPlugin("alpha");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("alpha");
    expect(p!.name).toBe("Plugin alpha");
    expect(p!.version).toBe("1.0.0");
  });

  it("skips a directory that has no plugin.json", () => {
    fs.mkdirSync(path.join(corePluginsDir(), "no-manifest"));
    loader.loadPlugins();
    expect(loader.getPlugin("no-manifest")).toBeNull();
  });

  it("skips a plugin.json that is missing required fields (id/name/version)", () => {
    const pluginDir = path.join(corePluginsDir(), "bad");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ id: "bad" })); // no name/version
    loader.loadPlugins();
    expect(loader.getPlugin("bad")).toBeNull();
  });

  it("does not load the same plugin id twice", () => {
    writePlugin(corePluginsDir(), "dup");
    loader.loadPlugins();
    loader.loadPlugins(); // second call
    expect(loader.listPlugins().filter((p) => p.id === "dup")).toHaveLength(1);
  });
});

// ── getPlugin / listPlugins ───────────────────────────────────────────────────

describe("getPlugin", () => {
  it("returns null for an id that was never loaded", () => {
    expect(loader.getPlugin("nonexistent")).toBeNull();
  });
});

describe("listPlugins", () => {
  it("returns an empty array when no plugins are loaded", () => {
    expect(loader.listPlugins()).toEqual([]);
  });

  it("shows status 'active' for a freshly loaded plugin", () => {
    writePlugin(corePluginsDir(), "beta");
    loader.loadPlugins();
    const list = loader.listPlugins();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("active");
  });
});

// ── disablePlugin / enablePlugin ─────────────────────────────────────────────

describe("disablePlugin / enablePlugin", () => {
  it("disablePlugin returns false for an unknown id", () => {
    expect(loader.disablePlugin("nope")).toBe(false);
  });

  it("disablePlugin marks a loaded plugin as disabled", () => {
    writePlugin(corePluginsDir(), "gamma");
    loader.loadPlugins();
    expect(loader.disablePlugin("gamma")).toBe(true);
    expect(loader.listPlugins()[0].status).toBe("disabled");
  });

  it("enablePlugin re-activates a disabled plugin", () => {
    writePlugin(corePluginsDir(), "delta");
    loader.loadPlugins();
    loader.disablePlugin("delta");
    expect(loader.enablePlugin("delta")).toBe(true);
    expect(loader.listPlugins()[0].status).toBe("active");
  });
});

// ── unloadPlugins ─────────────────────────────────────────────────────────────

describe("unloadPlugins", () => {
  it("clears all loaded plugins so listPlugins returns empty", () => {
    writePlugin(corePluginsDir(), "epsilon");
    loader.loadPlugins();
    loader.unloadPlugins();
    expect(loader.listPlugins()).toEqual([]);
    expect(loader.getPlugin("epsilon")).toBeNull();
  });
});

// ── runMiddleware ─────────────────────────────────────────────────────────────

describe("runMiddleware", () => {
  it("returns the original data unchanged when no middleware is registered", async () => {
    const data = { value: 42 };
    const result = await loader.runMiddleware("some:hook", data);
    expect(result).toEqual({ value: 42 });
  });
});
