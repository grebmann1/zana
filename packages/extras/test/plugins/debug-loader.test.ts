import { describe, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let pluginsDir = "";

vi.mock("@zana-ai/core", () => ({
  config: {
    get PLUGINS_DIR() { console.log("[MOCK] PLUGINS_DIR called, returning:", pluginsDir); return pluginsDir; },
    get ZANA_DIR()    { return pluginsDir; },
    get SETTINGS_PATH() { return path.join(pluginsDir, "settings.json"); },
  },
  events: { service: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()), query: vi.fn(() => []) } },
  agents: { manager: { listAgents: vi.fn(() => []), spawnHeadlessAgent: vi.fn(), killAgent: vi.fn() } },
}));

vi.mock("@zana-ai/work", () => ({
  tickets: { service: { listTickets: vi.fn(() => []), getTicket: vi.fn(), createTicket: vi.fn(), updateTicket: vi.fn() } },
}));

// Use RELATIVE path, same as sse-broadcaster.test.ts does
import * as loader from "../../src/plugins/loader.ts";

describe("debug loader", () => {
  beforeEach(() => {
    pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-debug-"));
  });
  afterEach(() => {
    loader.unloadPlugins();
    fs.rmSync(pluginsDir, { recursive: true, force: true });
  });

  it("PLUGINS_DIR mock called during loadPlugins with relative import?", () => {
    const pluginDir = path.join(pluginsDir, "alpha");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ id: "alpha", name: "Alpha", version: "1.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = {};");
    
    loader.loadPlugins();
    console.log("listPlugins:", loader.listPlugins());
  });
});
