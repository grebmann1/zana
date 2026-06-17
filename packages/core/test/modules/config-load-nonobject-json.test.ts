// modules/config — load() resilience to valid-but-non-object JSON on disk.
//
// The sibling config-load-malformed-json test pins behavior for UNPARSEABLE
// JSON (caught by the JSON.parse failure → catch arm). This file pins the
// distinct, previously-untested arm: a config file whose contents ARE valid
// JSON but are not an object — an array, a scalar, or a literal `null`/`true`.
//
// mergeDefaults() reads `config.modules` / `config.system` off whatever
// JSON.parse returns. For an array/number/string those property reads yield
// undefined (no throw), and for `null` the read throws and is swallowed by
// load()'s catch. Either way the documented invariant must hold: load() never
// throws and always returns a usable config — empty modules map + full system
// defaults. A regression here (e.g. someone trusting parsed input is an object)
// would surface as a crash on startup from a hand-edited/garbled config.json.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as cfg from "@zana-ai/core/src/modules/config.ts";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zana-config-nonobject-test-"));
  configPath = join(tmpDir, "config.json");
  cfg.setConfigPath(configPath);
  cfg.stopWatching();
});

afterEach(() => {
  cfg.stopWatching();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("load() — valid-but-non-object JSON on disk", () => {
  // Each value is legal JSON but not an object; all must degrade to defaults.
  const cases: Array<[string, string]> = [
    ["a JSON array", "[]"],
    ["a JSON number", "42"],
    ["a JSON string", '"hello"'],
    ["a JSON null", "null"],
    ["a JSON boolean", "true"],
  ];

  for (const [label, raw] of cases) {
    it(`falls back to an empty modules map for ${label}`, () => {
      writeFileSync(configPath, raw, "utf8");
      const loaded = cfg.load();
      expect(loaded.modules).toEqual({});
    });

    it(`ships full system defaults for ${label}`, () => {
      writeFileSync(configPath, raw, "utf8");
      const loaded = cfg.load();
      // Spot-check a representative default to prove the whole block is present.
      expect(loaded.system.initTimeout).toBe(10000);
      expect(loaded.system.maxConcurrentAgents).toBe(10);
    });

    it(`does not throw for ${label}`, () => {
      writeFileSync(configPath, raw, "utf8");
      expect(() => cfg.load()).not.toThrow();
    });
  }

  it("recovers cleanly: a valid object save()/load() round-trips after non-object contents", () => {
    writeFileSync(configPath, "[]", "utf8");
    cfg.load(); // degrade to defaults, no throw

    cfg.save({ modules: { alpha: { enabled: false, config: {} } }, system: {} });
    const reloaded = cfg.load();
    expect(reloaded.modules.alpha).toEqual({ enabled: false, config: {} });
  });
});
