// Unit tests for getMaxConcurrentAgents() in agents/lifecycle.ts.
//
// getMaxConcurrentAgents resolves via a three-tier waterfall:
//   1. ZANA_MAX_WORKERS env-var  (highest priority)
//   2. cfg.system.maxConcurrentAgents from moduleConfig
//   3. MAX_CONCURRENT_AGENTS constant (10, lowest priority / hard default)
//
// The waterfall uses JS `||` so any falsy value (0, NaN, undefined) falls
// through to the next tier.  Tests document and pin this behaviour, including
// the ZANA_MAX_WORKERS="0" edge case.
//
// Strategy: import directly from the .ts source (same pattern as the other
// lifecycle-* tests).  moduleConfig is pointed at a fresh tmp dir so tests
// start from an empty state and the default (10) is predictable.  Each test
// cleans up after itself — no shared mutable state escapes.
//
// No real spawning, no PTY, no network — fully deterministic.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { getMaxConcurrentAgents } from "@zana-ai/core/src/agents/lifecycle.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-max-workers-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  // Remove env override set by individual tests.
  delete process.env.ZANA_MAX_WORKERS;
  // Force moduleConfig to re-read from disk on next call (file absent → DEFAULTS).
  (moduleConfig as any).currentConfig = null;
  // Delete any config file written by this test so the next test starts clean.
  try { fs.unlinkSync(path.join(tmpDir, "config.json")); } catch {}
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

// ─── Tier 3: hard-coded default ───────────────────────────────────────────────

describe("getMaxConcurrentAgents — default fallback", () => {
  it("returns 10 when neither ZANA_MAX_WORKERS nor a config file is present", () => {
    expect(getMaxConcurrentAgents()).toBe(10);
  });

  it("returns 10 when system config exists but omits maxConcurrentAgents", () => {
    moduleConfig.save({
      modules: {},
      system: { cpuLoadThreshold: 0.9 },
    } as any);
    expect(getMaxConcurrentAgents()).toBe(10);
  });
});

// ─── Tier 2: config override ──────────────────────────────────────────────────

describe("getMaxConcurrentAgents — config tier", () => {
  it("returns the value from cfg.system.maxConcurrentAgents when set", () => {
    moduleConfig.save({
      modules: {},
      system: { maxConcurrentAgents: 3 },
    } as any);
    expect(getMaxConcurrentAgents()).toBe(3);
  });

  it("returns 1 (minimum sensible config) without falling back to default", () => {
    moduleConfig.save({
      modules: {},
      system: { maxConcurrentAgents: 1 },
    } as any);
    expect(getMaxConcurrentAgents()).toBe(1);
  });

  it("returns a large configured value without capping it", () => {
    moduleConfig.save({
      modules: {},
      system: { maxConcurrentAgents: 100 },
    } as any);
    expect(getMaxConcurrentAgents()).toBe(100);
  });
});

// ─── Tier 1: ZANA_MAX_WORKERS env-var ────────────────────────────────────────

describe("getMaxConcurrentAgents — ZANA_MAX_WORKERS env-var tier", () => {
  it("returns the numeric env-var value when ZANA_MAX_WORKERS is a positive integer string", () => {
    process.env.ZANA_MAX_WORKERS = "5";
    expect(getMaxConcurrentAgents()).toBe(5);
  });

  it("env-var overrides a config-level maxConcurrentAgents setting", () => {
    moduleConfig.save({
      modules: {},
      system: { maxConcurrentAgents: 2 },
    } as any);
    process.env.ZANA_MAX_WORKERS = "7";
    expect(getMaxConcurrentAgents()).toBe(7);
  });

  it("env-var overrides the default when no config file exists", () => {
    process.env.ZANA_MAX_WORKERS = "20";
    expect(getMaxConcurrentAgents()).toBe(20);
  });
});

// ─── Edge cases: falsy env-var falls through ──────────────────────────────────

describe("getMaxConcurrentAgents — falsy ZANA_MAX_WORKERS falls through", () => {
  it("falls back to config when ZANA_MAX_WORKERS is '0' (Number('0')===0, falsy)", () => {
    moduleConfig.save({
      modules: {},
      system: { maxConcurrentAgents: 4 },
    } as any);
    process.env.ZANA_MAX_WORKERS = "0";
    // Number("0") is 0 — falsy — so the || chain continues to config.
    expect(getMaxConcurrentAgents()).toBe(4);
  });

  it("falls back to default (10) when ZANA_MAX_WORKERS is '0' and config has no maxConcurrentAgents", () => {
    // Explicitly provide a config with no maxConcurrentAgents so the state is
    // deterministic regardless of what prior tests wrote.
    moduleConfig.save({ modules: {}, system: {} } as any);
    process.env.ZANA_MAX_WORKERS = "0";
    // cfg.system.maxConcurrentAgents is undefined → 0 || undefined || 10 = 10.
    expect(getMaxConcurrentAgents()).toBe(10);
  });

  it("falls back to config when ZANA_MAX_WORKERS is a non-numeric string (NaN is falsy)", () => {
    moduleConfig.save({
      modules: {},
      system: { maxConcurrentAgents: 6 },
    } as any);
    process.env.ZANA_MAX_WORKERS = "not-a-number";
    // Number("not-a-number") === NaN — falsy — falls through to config.
    expect(getMaxConcurrentAgents()).toBe(6);
  });
});
