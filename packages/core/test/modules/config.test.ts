// modules/config — covers the in-process config store:
//   - get() returns system defaults when the config file does not exist
//   - save() + load() round-trip: JSON is written and re-read correctly
//   - getModuleConfig() returns {enabled:true, config:{}} for unknown modules
//   - setModuleConfig() persists updates so load() reflects the change
//   - isModuleEnabled() respects the enabled flag
//   - applySchemaDefaults() fills missing keys, keeps existing values

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as cfg from "@zana-ai/core/src/modules/config.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zana-modules-config-test-"));
  cfg.setConfigPath(join(tmpDir, "config.json"));
  cfg.stopWatching();
  cfg.load(); // reset in-memory state from a fresh (missing) file
});

afterEach(() => {
  cfg.stopWatching();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── system defaults ────────────────────────────────────────────────────────

describe("get() — no file", () => {
  it("returns an empty modules map when the config file does not exist", () => {
    const c = cfg.get();
    expect(c.modules).toEqual({});
  });

  it("returns system defaults (initTimeout=10000) when config file is absent", () => {
    const c = cfg.get();
    expect(c.system.initTimeout).toBe(10000);
  });
});

// ── save / load round-trip ─────────────────────────────────────────────────

describe("save() + load()", () => {
  it("persists a module entry and load() re-reads it", () => {
    const before = cfg.get();
    before.modules["my-mod"] = { enabled: true, config: { key: "val" } };
    cfg.save(before);

    cfg.load();
    expect(cfg.get().modules["my-mod"].config.key).toBe("val");
  });

  it("writes valid JSON to disk", () => {
    cfg.save({ modules: { x: { enabled: false, config: {} } }, system: cfg.get().system });
    const raw = readFileSync(join(tmpDir, "config.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).modules.x.enabled).toBe(false);
  });
});

// ── partial system-override merge ───────────────────────────────────────────
// mergeDefaults() (run by load()) spreads the on-disk `system` block over the
// built-in DEFAULTS.system. A config file that overrides ONE system field must
// therefore keep every other default intact — overriding `maxConcurrentAgents`
// must not silently drop `initTimeout`/`agentTimeoutMinutes` to undefined.
// The existing suite only covers the all-defaults (no file) and module
// round-trip cases, leaving this merge invariant untested.

describe("load() — partial system override", () => {
  it("applies the overridden field but preserves the other system defaults", () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ system: { maxConcurrentAgents: 2 } }),
      "utf8",
    );
    cfg.load();
    const c = cfg.get();

    expect(c.system.maxConcurrentAgents).toBe(2); // explicit override wins
    expect(c.system.initTimeout).toBe(10000); // untouched default preserved
    expect(c.system.agentTimeoutMinutes).toBe(10); // untouched default preserved
    expect(c.system.zombieReaperEnabled).toBe(true); // untouched default preserved
    expect(c.modules).toEqual({}); // absent modules block -> empty map
  });
});

// ── module-level helpers ───────────────────────────────────────────────────

describe("getModuleConfig()", () => {
  it("returns enabled:true and empty config for an unknown module", () => {
    const mc = cfg.getModuleConfig("nonexistent");
    expect(mc.enabled).toBe(true);
    expect(mc.config).toEqual({});
  });
});

describe("setModuleConfig()", () => {
  it("updates the module entry so getModuleConfig() reflects the change", () => {
    cfg.setModuleConfig("alpha", { enabled: false, config: { threshold: 42 } });
    const mc = cfg.getModuleConfig("alpha");
    expect(mc.enabled).toBe(false);
    expect(mc.config.threshold).toBe(42);
  });

  it("merges with existing fields rather than replacing them", () => {
    cfg.setModuleConfig("alpha", { enabled: true, config: { a: 1 } });
    cfg.setModuleConfig("alpha", { config: { b: 2 } });
    const mc = cfg.getModuleConfig("alpha");
    expect(mc.config.b).toBe(2);
  });
});

describe("isModuleEnabled()", () => {
  it("returns true for an unknown module (default is enabled)", () => {
    expect(cfg.isModuleEnabled("no-such-module")).toBe(true);
  });

  it("returns false after the module is explicitly disabled", () => {
    cfg.setModuleConfig("disabled-mod", { enabled: false, config: {} });
    expect(cfg.isModuleEnabled("disabled-mod")).toBe(false);
  });
});

// ── schema defaults ────────────────────────────────────────────────────────

describe("applySchemaDefaults()", () => {
  it("sets default values for keys that are absent", () => {
    cfg.applySchemaDefaults("beta", { timeout: { default: 5000 }, retries: { default: 3 } });
    const mc = cfg.getModuleConfig("beta");
    expect(mc.config.timeout).toBe(5000);
    expect(mc.config.retries).toBe(3);
  });

  it("does NOT overwrite keys that already have a value", () => {
    cfg.setModuleConfig("beta", { enabled: true, config: { timeout: 9999 } });
    cfg.applySchemaDefaults("beta", { timeout: { default: 5000 } });
    expect(cfg.getModuleConfig("beta").config.timeout).toBe(9999);
  });

  it("is a no-op when schema is null or undefined", () => {
    expect(() => cfg.applySchemaDefaults("beta", null as any)).not.toThrow();
    expect(() => cfg.applySchemaDefaults("beta", undefined as any)).not.toThrow();
  });
});
