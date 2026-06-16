// modules/config — load() resilience to a corrupt config file.
//
// load() wraps readFileSync + JSON.parse in a try/catch and, on ANY failure,
// resets currentConfig to a fresh copy of DEFAULTS (empty modules map + full
// system defaults). The existing suite covers the missing-file path but never
// the malformed-JSON path: a config.json that exists on disk but does not parse
// as JSON. A regression here (e.g. letting the parse error propagate) would
// crash daemon startup whenever the config file is half-written or corrupted,
// so the fallback is worth pinning down explicitly.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as cfg from "@zana-ai/core/src/modules/config.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zana-modules-config-malformed-"));
  cfg.setConfigPath(join(tmpDir, "config.json"));
  cfg.stopWatching();
});

afterEach(() => {
  cfg.stopWatching();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("load() — malformed JSON on disk", () => {
  it("falls back to system defaults instead of throwing", () => {
    writeFileSync(join(tmpDir, "config.json"), "{ this is : not valid json,", "utf8");

    expect(() => cfg.load()).not.toThrow();
    const c = cfg.get();

    // Full system defaults are restored from DEFAULTS.system …
    expect(c.system.initTimeout).toBe(10000);
    expect(c.system.maxConcurrentAgents).toBe(10);
    expect(c.system.agentTimeoutMinutes).toBe(10);
    // … and the modules map is reset to empty (no partial parse leaks through).
    expect(c.modules).toEqual({});
  });

  it("recovers cleanly: a later valid save()/load() round-trips after corruption", () => {
    writeFileSync(join(tmpDir, "config.json"), "}{ broken", "utf8");
    cfg.load(); // absorbs the corruption -> defaults

    const recovered = cfg.get();
    recovered.modules["mod-after-corrupt"] = { enabled: false, config: { ok: true } };
    cfg.save(recovered);

    cfg.load();
    expect(cfg.getModuleConfig("mod-after-corrupt").enabled).toBe(false);
    expect(cfg.getModuleConfig("mod-after-corrupt").config.ok).toBe(true);
  });
});
