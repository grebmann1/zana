// FU-config — verifies the deliberation core module:
//   - manifest is well-formed (id, configSchema, all 10 keys with defaults)
//   - applySchemaDefaults seeds an empty config block with all 10 defaults
//   - the @zana/work runtime-config bridge round-trips set/get/reset
//   - the @zana/core probe-config bridge round-trips set/get/reset
//   - module init() publishes to BOTH bridges from ctx.config
//   - module onConfigChanged() re-publishes after a config edit

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import * as moduleConfig from "@zana/core/src/modules/config.ts";
import * as probeConfigDirect from "@zana/core/src/agents/probe-config.ts";
import * as workspaceContext from "@zana/core/src/project/workspace-context.ts";
import { resetRuntimeConfig, getRuntimeConfig } from "@zana/work/src/deliberation/runtime-config.ts";

// The module's index.js does `require("@zana/core").agents.probeConfig` which
// resolves through Node's CJS loader → packages/core/dist/src/index.js when
// running under vitest (since dist is the package "main"). The TS source we
// import directly (`probeConfigDirect`) is a *separate* module instance under
// vite-ssr. To verify the bridge round-trip we have to read from the same
// instance the module wrote to: `require("@zana/core").agents.probeConfig`.
function getRuntimeProbeConfig() {
  // Lazy require — keeps the test file importable even if @zana/core dist
  // isn't built yet (the dist build is a precondition of running tests).
  const core = require("@zana/core");
  return core.agents.probeConfig;
}

const MODULE_DIR = path.resolve(__dirname, "../../modules/deliberation");
const MANIFEST_PATH = path.join(MODULE_DIR, "module.json");

const EXPECTED_KEYS = [
  "defaultRounds",
  "defaultQuorum",
  "defaultMode",
  "checkpointTTLDays",
  "occMaxRetries",
  "probeTimeoutMs",
  "probeRawMaxBytes",
  "probeCacheTtlMs",
  "synthesisSimilarityThreshold",
  "voterTimeoutMs",
];

const EXPECTED_DEFAULTS: Record<string, unknown> = {
  defaultRounds: 2,
  defaultQuorum: "majority",
  defaultMode: "synthesis",
  checkpointTTLDays: 7,
  occMaxRetries: 3,
  probeTimeoutMs: 30000,
  probeRawMaxBytes: 1024,
  probeCacheTtlMs: 300000,
  synthesisSimilarityThreshold: 0.45,
  voterTimeoutMs: 1200000,
};

describe("deliberation core module (FU-config)", () => {
  let tmpRoot: string;
  let manifest: any;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "zana-delib-mod-"));
    workspaceContext.init(tmpRoot);
    // Force a fresh config.json in the temp project dir.
    moduleConfig.setConfigPath(path.join(tmpRoot, "config.json"));
    moduleConfig.load();

    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

    resetRuntimeConfig();
    probeConfigDirect.resetProbeConfig();
    try { getRuntimeProbeConfig().resetProbeConfig(); } catch {}
  });

  afterEach(() => {
    resetRuntimeConfig();
    probeConfigDirect.resetProbeConfig();
    try { getRuntimeProbeConfig().resetProbeConfig(); } catch {}
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Manifest shape
  // ──────────────────────────────────────────────────────────────────────────

  it("manifest has correct id, name, version, main, and event declarations", () => {
    expect(manifest.id).toBe("deliberation");
    expect(manifest.name).toBe("Deliberation");
    expect(typeof manifest.version).toBe("string");
    expect(manifest.main).toBe("index.js");
    expect(Array.isArray(manifest.events?.emits)).toBe(true);
    expect(manifest.events.emits).toEqual(
      expect.arrayContaining([
        "deliberation:proposed",
        "deliberation:vote",
        "deliberation:synthesis",
        "deliberation:converged",
        "deliberation:escalated",
        "deliberation:override",
      ]),
    );
  });

  it("configSchema declares all 10 keys with the expected defaults", () => {
    const schema = manifest.configSchema;
    expect(schema).toBeDefined();
    for (const key of EXPECTED_KEYS) {
      expect(schema[key]).toBeDefined();
      expect(schema[key].default).toEqual(EXPECTED_DEFAULTS[key]);
      expect(typeof schema[key].description).toBe("string");
      expect(schema[key].description.length).toBeGreaterThan(0);
    }
    // No surprise extra keys.
    expect(Object.keys(schema).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  // ──────────────────────────────────────────────────────────────────────────
  // applySchemaDefaults — config bootstrapping
  // ──────────────────────────────────────────────────────────────────────────

  it("applySchemaDefaults seeds the module config block with all 10 defaults", () => {
    moduleConfig.applySchemaDefaults("deliberation", manifest.configSchema);
    const mc = moduleConfig.getModuleConfig("deliberation");
    for (const key of EXPECTED_KEYS) {
      expect(mc.config[key]).toEqual(EXPECTED_DEFAULTS[key]);
    }
  });

  it("applySchemaDefaults preserves existing user overrides", () => {
    moduleConfig.setModuleConfig("deliberation", { config: { defaultRounds: 5 } });
    moduleConfig.applySchemaDefaults("deliberation", manifest.configSchema);
    const mc = moduleConfig.getModuleConfig("deliberation");
    expect(mc.config.defaultRounds).toBe(5); // user override preserved
    expect(mc.config.checkpointTTLDays).toBe(7); // default still seeded
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Runtime-config bridges (set/get/reset)
  // ──────────────────────────────────────────────────────────────────────────

  it("setRuntimeConfig({defaultRounds: 5}) → getRuntimeConfig().defaultRounds === 5", () => {
    const work = require("@zana/work");
    work.deliberation.setRuntimeConfig({ defaultRounds: 5 });
    expect(work.deliberation.getRuntimeConfig().defaultRounds).toBe(5);
    // Untouched keys keep their existing value (merge-over-current semantic).
    expect(work.deliberation.getRuntimeConfig().checkpointTTLDays).toBe(7);
  });

  it("setRuntimeConfig accumulates partial calls (merge-over-current, not replace-from-defaults)", () => {
    const work = require("@zana/work");
    work.deliberation.setRuntimeConfig({ defaultRounds: 5 });
    work.deliberation.setRuntimeConfig({ checkpointTTLDays: 14 });
    const cfg = work.deliberation.getRuntimeConfig();
    expect(cfg.defaultRounds).toBe(5);          // first call survives
    expect(cfg.checkpointTTLDays).toBe(14);     // second call applied
  });

  it("resetRuntimeConfig restores all 10 deliberation defaults", () => {
    const work = require("@zana/work");
    work.deliberation.setRuntimeConfig({
      defaultRounds: 99,
      defaultQuorum: "all",
      checkpointTTLDays: 30,
      occMaxRetries: 0,
      synthesisSimilarityThreshold: 0.9,
    });
    work.deliberation.resetRuntimeConfig();
    const cfg = work.deliberation.getRuntimeConfig();
    for (const key of EXPECTED_KEYS) {
      expect(cfg[key]).toEqual(EXPECTED_DEFAULTS[key]);
    }
  });

  it("setProbeConfig + getProbeConfig + resetProbeConfig round-trip (direct TS instance)", () => {
    probeConfigDirect.setProbeConfig({ probeTimeoutMs: 500, probeRawMaxBytes: 64 });
    expect(probeConfigDirect.getProbeConfig().probeTimeoutMs).toBe(500);
    expect(probeConfigDirect.getProbeConfig().probeRawMaxBytes).toBe(64);
    probeConfigDirect.resetProbeConfig();
    expect(probeConfigDirect.getProbeConfig().probeTimeoutMs).toBe(30000);
    expect(probeConfigDirect.getProbeConfig().probeRawMaxBytes).toBe(1024);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Module lifecycle — init() publishes config to both bridges
  // ──────────────────────────────────────────────────────────────────────────

  function loadModule() {
    // Bypass require cache so prior tests don't pin module state.
    const mainPath = path.join(MODULE_DIR, "index.js");
    delete require.cache[require.resolve(mainPath)];
    return require(mainPath);
  }

  function makeCtx(cfg: Record<string, unknown>) {
    return {
      moduleId: "deliberation",
      bus: { emit: () => {}, on: () => () => {}, query: () => [] },
      storage: { project: tmpRoot, global: tmpRoot, resolve: (s: string) => s, resolveGlobal: (s: string) => s },
      config: cfg,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      getModule: () => null,
      workspace: { root: () => tmpRoot, projectDir: () => tmpRoot, paths: () => ({}) },
    };
  }

  it("init(ctx) publishes ctx.config to both runtime bridges", async () => {
    const mod = loadModule();
    await mod.init(makeCtx({
      defaultRounds: 4,
      defaultQuorum: "all",
      defaultMode: "tally",
      checkpointTTLDays: 14,
      occMaxRetries: 5,
      probeTimeoutMs: 12345,
      probeRawMaxBytes: 256,
      synthesisSimilarityThreshold: 0.6,
    }));

    const work = require("@zana/work");
    expect(work.deliberation.getRuntimeConfig().defaultRounds).toBe(4);
    expect(work.deliberation.getRuntimeConfig().defaultQuorum).toBe("all");
    expect(work.deliberation.getRuntimeConfig().defaultMode).toBe("tally");
    expect(work.deliberation.getRuntimeConfig().checkpointTTLDays).toBe(14);
    expect(work.deliberation.getRuntimeConfig().occMaxRetries).toBe(5);
    expect(work.deliberation.getRuntimeConfig().synthesisSimilarityThreshold).toBe(0.6);

    // Module-side bridge — read through the same instance the module wrote to.
    const pc = getRuntimeProbeConfig();
    expect(pc.getProbeConfig().probeTimeoutMs).toBe(12345);
    expect(pc.getProbeConfig().probeRawMaxBytes).toBe(256);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Tenant-isolation pre-flight (FU-config-5)
  //
  // When the deliberation module loads but no workspace is initialized, the
  // runtime config is project-scoped while the checkpoint store + CAS would
  // silently fall back to ~/.zana/* (cross-tenant view). FU-T2d/T4c refuse
  // those writes hard at the gate; the module init should surface a warn
  // so the failure mode is signposted before the first propose() call.
  // ──────────────────────────────────────────────────────────────────────────
  it("module init warns when workspace not initialized", async () => {
    // Drop both workspace-context module instances back to "uninitialized".
    // The TS-imported one (workspaceContext) is what beforeEach init'd, and
    // the dist-resolved one is what the module's own require() reaches. We
    // poke the file-private fields to simulate "no workspace bootstrapped".
    const wcDist: any = require("@zana/core").project.workspaceContext;
    for (const wc of [workspaceContext as any, wcDist]) {
      try { if (typeof wc._resetForTesting === "function") wc._resetForTesting(); } catch {}
    }
    expect(wcDist.isInitialized()).toBe(false);

    const warnCalls: string[] = [];
    const ctx = {
      moduleId: "deliberation",
      bus: { emit: () => {}, on: () => () => {}, query: () => [] },
      storage: { project: tmpRoot, global: tmpRoot, resolve: (s: string) => s, resolveGlobal: (s: string) => s },
      config: {},
      logger: {
        info: () => {},
        warn: (msg: string) => { warnCalls.push(msg); },
        error: () => {},
        debug: () => {},
      },
      getModule: () => null,
      workspace: { root: () => tmpRoot, projectDir: () => tmpRoot, paths: () => ({}) },
    };

    const mod = loadModule();
    await mod.init(ctx);

    const matched = warnCalls.find((m) => /uninitialized workspace/.test(m));
    expect(matched).toBeDefined();
    expect(matched).toMatch(/deliberation writes will be refused/);
  });

  it("onConfigChanged re-publishes new config to both bridges", async () => {
    const mod = loadModule();
    await mod.init(makeCtx({ defaultRounds: 2, probeTimeoutMs: 30000 }));

    mod.onConfigChanged({
      defaultRounds: 7,
      defaultQuorum: "majority",
      defaultMode: "synthesis",
      checkpointTTLDays: 7,
      occMaxRetries: 3,
      probeTimeoutMs: 9999,
      probeRawMaxBytes: 1024,
      synthesisSimilarityThreshold: 0.45,
    });

    const work = require("@zana/work");
    expect(work.deliberation.getRuntimeConfig().defaultRounds).toBe(7);
    expect(getRuntimeProbeConfig().getProbeConfig().probeTimeoutMs).toBe(9999);
  });
});
