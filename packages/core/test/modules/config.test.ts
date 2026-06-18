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

  // Pins the resource/retry defaults baked into the DEFAULTS.system literal so
  // an accidental edit to that block is caught at the config layer (not only
  // via downstream behavioral tests). cpuGateEnabled in particular flipped to
  // `false` in a recent change — this guards that the CPU spawn-gate stays OFF
  // by default and that the transient-retry knobs keep their shipped values.
  it("ships the resource/retry system defaults when config file is absent", () => {
    const c = cfg.get();
    expect(c.system.cpuGateEnabled).toBe(false); // CPU spawn-gate OFF by default
    expect(c.system.maxConcurrentAgents).toBe(10);
    // Execution strategy defaults to process-per-agent; "subagent" is opt-in.
    expect(c.system.executionStrategy).toBe("process");
    expect(c.system.agentTimeoutMinutes).toBe(10);
    expect(c.system.spawnThrottleStreakLimit).toBe(5);
    expect(c.system.transientRetryMaxAttempts).toBe(3);
    expect(c.system.transientRetryBackoffMs).toEqual([30000, 120000, 480000]);
  });

  // Pins the auto-router defaults baked into DEFAULTS.system. core.ts's
  // onTicketCreated bridge reads these directly off the `system` block:
  // autoAssignProfile gates whether a new ticket gets a best-fit profile
  // auto-bound, autoAssignConfidence is the score floor for that binding, and
  // autoCloseStale gates the sweeper's stale-close behavior. A dropped or
  // renamed key would silently change feature behavior with no other signal,
  // so guard the shipped values at the config layer. autoCloseStale in
  // particular is otherwise unexercised by any test.
  it("ships the auto-router system defaults when config file is absent", () => {
    const c = cfg.get();
    expect(c.system.autoAssignProfile).toBe(true);
    expect(c.system.autoAssignConfidence).toBe(0.15);
    expect(c.system.autoCloseStale).toBe(false);
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

  // save() runs ensureDir(dirname(p)) before writing, so it must succeed even
  // when the config file's parent directory does not yet exist (e.g. first
  // write into a freshly-resolved project dir). Every other test points the
  // config path at the already-created tmpDir, leaving this branch untested.
  it("creates the parent directory when it does not yet exist", () => {
    const nested = join(tmpDir, "does", "not", "exist", "config.json");
    cfg.setConfigPath(nested);
    expect(existsSync(join(tmpDir, "does"))).toBe(false); // parent absent pre-save

    cfg.save({ modules: { fresh: { enabled: true, config: { k: 1 } } }, system: cfg.get().system });

    expect(existsSync(nested)).toBe(true); // file written
    expect(JSON.parse(readFileSync(nested, "utf8")).modules.fresh.config.k).toBe(1);
  });

  // save() writes to a sibling `<path>.tmp` then renameSync()s it over the real
  // file (config.ts lines 48-50) so a reader never observes a half-written
  // config. After a successful save the temp sidecar must NOT linger — a
  // regression that drops the rename (writing straight to `.tmp`) or skips
  // cleanup would leave the artifact behind and silently break atomicity. No
  // existing test inspects the temp path, so pin both halves here.
  it("writes atomically and leaves no .tmp sidecar after save()", () => {
    const target = join(tmpDir, "config.json");
    cfg.save({ modules: { atomic: { enabled: true, config: {} } }, system: cfg.get().system });

    expect(existsSync(target)).toBe(true); // real file present
    expect(existsSync(target + ".tmp")).toBe(false); // temp sidecar cleaned up
    expect(JSON.parse(readFileSync(target, "utf8")).modules.atomic.enabled).toBe(true);
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

  // getModuleConfig() reads ONLY the `modules` map (config.ts line 73:
  // `cfg.modules[moduleId]`). The top-level `system` block (DEFAULTS.system,
  // e.g. autoAssignProfile / autoAssignConfidence) lives in a SEPARATE
  // namespace and is reachable via get().system — NOT via
  // getModuleConfig("system"). So getModuleConfig("system") does not surface
  // the system settings; it returns the unknown-module fallback. This pins the
  // namespace separation: a caller wanting system settings must use
  // get().system, and the value here must NOT expose autoAssignProfile.
  it("does NOT expose the top-level system block via getModuleConfig('system')", () => {
    const mc = cfg.getModuleConfig("system");
    // Falls through to the unknown-module default, not the DEFAULTS.system block.
    expect(mc).toEqual({ enabled: true, config: {} });
    expect((mc as any).autoAssignProfile).toBeUndefined();
    // The real system settings remain reachable through get().system.
    expect(cfg.get().system.autoAssignProfile).toBe(true);
    expect(cfg.get().system.autoAssignConfidence).toBe(0.15);
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

  // setModuleConfig() does a SHALLOW spread at the entry level
  // (`{ ...existing, ...data }`, config.ts line 78): top-level sibling keys the
  // second call omits (e.g. `enabled`) survive, but the nested `config` object
  // is REPLACED wholesale rather than deep-merged — so `config.a` from the first
  // call is gone once the second call supplies a new `config`. This pins both
  // halves of that contract; a regression to deep-merge or to a full overwrite
  // would break one of the assertions.
  it("preserves omitted top-level keys but replaces (not deep-merges) the nested config", () => {
    cfg.setModuleConfig("merge-mod", { enabled: false, config: { a: 1 } });
    cfg.setModuleConfig("merge-mod", { config: { b: 2 } });
    const mc = cfg.getModuleConfig("merge-mod");
    expect(mc.enabled).toBe(false); // omitted sibling key survives the shallow merge
    expect(mc.config.b).toBe(2); // new nested value present
    expect(mc.config.a).toBeUndefined(); // old nested key dropped — config replaced, not deep-merged
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

  // applySchemaDefaults() only assigns a key when its schema entry declares a
  // default: the guard `def.default !== undefined` (config.ts line 94) means a
  // schema field with NO `default` property must be left absent rather than
  // written as `undefined`. The existing suite always supplies `{ default: X }`,
  // so this no-default branch is untested. Pins that a schema describing a key
  // without a default does not pollute the module config with an explicit
  // `undefined` value (it stays a genuine absence, so `"key" in config` is false
  // and a later real default can still fill it).
  it("does NOT create a key for a schema entry that declares no default", () => {
    cfg.applySchemaDefaults("delta", {
      withDefault: { default: 7 },
      noDefault: { description: "documented but optional" },
    });
    const mc = cfg.getModuleConfig("delta");

    expect(mc.config.withDefault).toBe(7); // default-bearing key is filled
    expect(mc.config.noDefault).toBeUndefined(); // no-default key is untouched
    expect("noDefault" in mc.config).toBe(false); // absent, not an explicit undefined
  });

  // applySchemaDefaults() guards `if (!mc.config) mc.config = {}` (config.ts
  // lines 91-92) for an existing module entry that has no `config` object at
  // all — e.g. a hand-authored config.json that wrote `{"enabled": true}` with
  // no nested config. Every other test reaches modules either via the
  // fresh-entry path (which seeds `config: {}`) or setModuleConfig (which sets
  // config), so this config-less branch is otherwise unexercised. Pins that the
  // missing config object is created and populated WITHOUT clobbering the
  // sibling `enabled` flag. Deterministic: pure in-memory mutation.
  it("creates the config object for an existing module entry that lacks one", () => {
    const c = cfg.get();
    c.modules["zeta"] = { enabled: true } as any; // entry present, no `config` key
    expect("config" in c.modules["zeta"]).toBe(false);

    cfg.applySchemaDefaults("zeta", { timeout: { default: 5000 } });

    const mc = cfg.getModuleConfig("zeta");
    expect(mc.config).toBeDefined();
    expect(mc.config.timeout).toBe(5000); // default filled into the new config object
    expect(mc.enabled).toBe(true); // sibling flag preserved, not reset
  });

  it("is a no-op when schema is null or undefined", () => {
    expect(() => cfg.applySchemaDefaults("beta", null as any)).not.toThrow();
    expect(() => cfg.applySchemaDefaults("beta", undefined as any)).not.toThrow();
  });

  // applySchemaDefaults() guards each key with `mc.config[key] === undefined`
  // (config.ts line 93) — a STRICT undefined check, not a truthiness test. So a
  // key whose existing value is falsy-but-present (0, false, "") is a real
  // user/runtime choice and must NOT be clobbered by the schema default. The
  // existing "does NOT overwrite" test only pins a truthy value (9999), leaving
  // the falsy edge untested. Pins the contract against a regression that swaps
  // the guard to `if (!mc.config[key])`, which would silently overwrite a
  // deliberate 0 / false / "" with the default. Deterministic: pure in-memory.
  it("does NOT overwrite an existing falsy value (0 / false / '') with the default", () => {
    cfg.setModuleConfig("epsilon", {
      enabled: true,
      config: { count: 0, flag: false, name: "" },
    });
    cfg.applySchemaDefaults("epsilon", {
      count: { default: 99 },
      flag: { default: true },
      name: { default: "fallback" },
    });
    const mc = cfg.getModuleConfig("epsilon");
    expect(mc.config.count).toBe(0); // a deliberate 0 survives
    expect(mc.config.flag).toBe(false); // a deliberate false survives
    expect(mc.config.name).toBe(""); // a deliberate empty string survives
  });

  // applySchemaDefaults() mutates only the in-memory `currentConfig` (config.ts
  // sets `currentConfig = cfg`) and, unlike setModuleConfig(), never calls
  // save(). Applying a module's schema defaults must therefore stay purely
  // in-process: the on-disk config.json must NOT be created/written, so the
  // file keeps only user-authored values rather than being polluted with every
  // module's computed defaults. Pins that persistence boundary — currently
  // untested — and contrasts it with setModuleConfig(), which DOES persist.
  it("does not persist defaults to disk (in-memory only, no config.json written)", () => {
    const file = join(tmpDir, "config.json");
    expect(existsSync(file)).toBe(false); // fresh missing-file state from beforeEach

    cfg.applySchemaDefaults("gamma", { timeout: { default: 5000 } });

    // In-memory state reflects the applied default...
    expect(cfg.getModuleConfig("gamma").config.timeout).toBe(5000);
    // ...but nothing was written to disk.
    expect(existsSync(file)).toBe(false);

    // Contrast: setModuleConfig() DOES persist, proving the assertion above is
    // about applySchemaDefaults' behavior, not a broken config path.
    cfg.setModuleConfig("gamma", { config: { other: 1 } });
    expect(existsSync(file)).toBe(true);
  });
});
