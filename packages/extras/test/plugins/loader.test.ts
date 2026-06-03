// Tests for packages/extras/src/plugins/loader.ts
// Covers: load/skip, getPlugin, listPlugins, disable/enable, unload, runMiddleware.
// All file I/O uses tmp dirs; @zana-ai/core and @zana-ai/work are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

// ── Real-module handle — vi.mock() only intercepts ESM `import` statements.
// The loader uses `function _core() { return require("@zana-ai/core") }` at
// runtime, which bypasses vi.mock and hits the real CJS module.  We grab that
// real module here so we can temporarily redirect its config properties to the
// test's tmp dir.
const _req = createRequire(import.meta.url);
const realCore = _req("@zana-ai/core") as {
  config: { PLUGINS_DIR: string; ZANA_DIR: string; SETTINGS_PATH: string };
};
let _savedPluginsDir = realCore.config.PLUGINS_DIR;
let _savedZanaDir = realCore.config.ZANA_DIR;
let _savedSettingsPath = realCore.config.SETTINGS_PATH;

// ── Mocks — must appear before the import of loader ────────────────────────
// vi.hoisted() runs in the hoisted zone so the returned object is available to
// both the vi.mock factory (also hoisted) and the beforeEach assignments below.
// This avoids TDZ issues that arise when a plain `let` variable is captured by
// a vi.mock factory that Vitest hoists before variable declarations.

const coreMock = vi.hoisted(() => ({
  config: { PLUGINS_DIR: "", ZANA_DIR: "", SETTINGS_PATH: "" },
  events: {
    service: {
      emit: vi.fn(),
      subscribe: vi.fn(() => vi.fn()), // returns a no-op unsubscribe
      query: vi.fn(() => []),
    },
  },
  agents: {
    manager: {
      listAgents: vi.fn(() => []),
      spawnHeadlessAgent: vi.fn(),
      killAgent: vi.fn(),
    },
  },
}));

const workMock = vi.hoisted(() => ({
  tickets: {
    service: {
      listTickets: vi.fn(() => []),
      getTicket: vi.fn(),
      createTicket: vi.fn(),
      updateTicket: vi.fn(),
    },
  },
}));

vi.mock("@zana-ai/core", () => coreMock);
vi.mock("@zana-ai/work", () => workMock);

import * as loader from "../../src/plugins/loader.ts";

// ── Module-level mutable state (used by helpers and beforeEach) ──────────────
let pluginsDir = "";

// ── Helpers ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

// Use a project-local scratch directory so Vite's SSR module runner can
// require() plugin index.js files (files outside the project root are blocked).
const SCRATCH_BASE = path.join(path.dirname(new URL(import.meta.url).pathname), ".scratch");

function makeTmpDir(): string {
  fs.mkdirSync(SCRATCH_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH_BASE, "zana-loader-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writePlugin(baseDir: string, id: string, extra: Record<string, unknown> = {}) {
  const pluginDir = path.join(baseDir, id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ id, name: `Plugin ${id}`, version: "1.0.0", main: "index.js", ...extra }),
  );
  fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = {};\n");
}

beforeEach(() => {
  pluginsDir = makeTmpDir();
  // Sync the mutable config mock so the loader reads the right tmp dir.
  coreMock.config.PLUGINS_DIR = pluginsDir;
  coreMock.config.ZANA_DIR = pluginsDir;
  coreMock.config.SETTINGS_PATH = path.join(pluginsDir, "settings.json");
  // Restore subscribe implementation (clearAllMocks wipes it).
  coreMock.events.service.subscribe.mockReturnValue(vi.fn());
  vi.clearAllMocks();
  // Re-apply after clear so tests that call subscribe get a valid unsubscribe.
  coreMock.events.service.subscribe.mockReturnValue(vi.fn());

  // The loader calls `require("@zana-ai/core")` at runtime (CJS require), which
  // bypasses vi.mock and returns the REAL module.  Override its config properties
  // so PLUGINS_DIR() inside loadPlugins() points at the test's tmp dir.
  _savedPluginsDir = realCore.config.PLUGINS_DIR;
  _savedZanaDir = realCore.config.ZANA_DIR;
  _savedSettingsPath = realCore.config.SETTINGS_PATH;
  realCore.config.PLUGINS_DIR = pluginsDir;
  realCore.config.ZANA_DIR = pluginsDir;
  realCore.config.SETTINGS_PATH = path.join(pluginsDir, "settings.json");
});

afterEach(() => {
  loader.unloadPlugins();
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  // Tidy up scratch base if it is now empty
  try { fs.rmdirSync(SCRATCH_BASE); } catch { /* non-empty or already gone — fine */ }
  // Restore real core config.
  realCore.config.PLUGINS_DIR = _savedPluginsDir;
  realCore.config.ZANA_DIR = _savedZanaDir;
  realCore.config.SETTINGS_PATH = _savedSettingsPath;
});

// ── loadPlugins ──────────────────────────────────────────────────────────────

describe("loadPlugins", () => {
  it("loads a valid plugin and makes it retrievable via getPlugin", () => {
    writePlugin(pluginsDir, "alpha");
    console.log("[diag] pluginsDir=", pluginsDir);
    console.log("[diag] coreMock.config.PLUGINS_DIR=", coreMock.config.PLUGINS_DIR);
    loader.loadPlugins();
    console.log("[diag] listPlugins=", loader.listPlugins());
    const p = loader.getPlugin("alpha");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("alpha");
    expect(p!.name).toBe("Plugin alpha");
    expect(p!.version).toBe("1.0.0");
  });

  it("skips a directory that has no plugin.json", () => {
    fs.mkdirSync(path.join(pluginsDir, "no-manifest"));
    loader.loadPlugins();
    expect(loader.getPlugin("no-manifest")).toBeNull();
  });

  it("skips a plugin.json that is missing required fields (id/name/version)", () => {
    const pluginDir = path.join(pluginsDir, "bad");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ id: "bad" })); // no name/version
    loader.loadPlugins();
    expect(loader.getPlugin("bad")).toBeNull();
  });

  it("does not load the same plugin id twice", () => {
    writePlugin(pluginsDir, "dup");
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
    writePlugin(pluginsDir, "beta");
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
    writePlugin(pluginsDir, "gamma");
    loader.loadPlugins();
    expect(loader.disablePlugin("gamma")).toBe(true);
    expect(loader.listPlugins()[0].status).toBe("disabled");
  });

  it("enablePlugin re-activates a disabled plugin", () => {
    writePlugin(pluginsDir, "delta");
    loader.loadPlugins();
    loader.disablePlugin("delta");
    expect(loader.enablePlugin("delta")).toBe(true);
    expect(loader.listPlugins()[0].status).toBe("active");
  });
});

// ── unloadPlugins ─────────────────────────────────────────────────────────────

describe("unloadPlugins", () => {
  it("clears all loaded plugins so listPlugins returns empty", () => {
    writePlugin(pluginsDir, "epsilon");
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
