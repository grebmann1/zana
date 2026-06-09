// Unit tests for the spawn-overload streak helpers in agents/lifecycle.ts.
//
// These functions control the escalation path from retryable "soft load" refusals
// to TERMINAL errors that tell orchestrators to stop burning turns.  They are the
// single source of truth for per-parent streak counting and must behave correctly
// under multi-parent, null-parent, and config-override scenarios.
//
// Strategy: import directly from the .ts source (same pattern as
// lifecycle-check-resources.test.ts).  The map is cleared in afterEach so
// tests are independent.  moduleConfig is pointed at a fresh tmp dir so
// getSpawnThrottleStreakLimit() uses DEFAULTS (5) unless overridden.
//
// No real spawning, no PTY, no network — fully deterministic.

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  recordSpawnOverload,
  clearSpawnOverloadStreak,
  spawnOverloadStreaks,
  getSpawnThrottleStreakLimit,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-overload-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

afterEach(() => {
  // Reset all streak state between tests.
  spawnOverloadStreaks.clear();
  // Reset module config to defaults (no file → DEFAULTS: streakLimit = 5).
  (moduleConfig as any).currentConfig = null;
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

// ---------------------------------------------------------------------------
describe("recordSpawnOverload", () => {
  it("returns 1 on the first overload for a new parent", () => {
    expect(recordSpawnOverload("parent-A")).toBe(1);
  });

  it("increments and returns the running count on successive calls", () => {
    recordSpawnOverload("parent-B");
    recordSpawnOverload("parent-B");
    const count = recordSpawnOverload("parent-B");
    expect(count).toBe(3);
  });

  it("tracks separate streaks for different parents independently", () => {
    recordSpawnOverload("parent-X");
    recordSpawnOverload("parent-X");
    recordSpawnOverload("parent-Y");

    expect(spawnOverloadStreaks.get("parent-X")).toBe(2);
    expect(spawnOverloadStreaks.get("parent-Y")).toBe(1);
  });

  it("uses the empty string key when parentAgentId is null", () => {
    recordSpawnOverload(null);
    expect(spawnOverloadStreaks.get("")).toBe(1);
  });

  it("uses the empty string key when parentAgentId is undefined", () => {
    recordSpawnOverload(undefined);
    expect(spawnOverloadStreaks.get("")).toBe(1);
  });

  it("null and undefined share the same '' key (top-level slot)", () => {
    recordSpawnOverload(null);
    recordSpawnOverload(undefined);
    expect(spawnOverloadStreaks.get("")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("clearSpawnOverloadStreak", () => {
  it("removes an existing streak entry", () => {
    recordSpawnOverload("parent-C");
    clearSpawnOverloadStreak("parent-C");
    expect(spawnOverloadStreaks.has("parent-C")).toBe(false);
  });

  it("is a no-op when the key does not exist (no throw)", () => {
    expect(() => clearSpawnOverloadStreak("unknown-parent")).not.toThrow();
  });

  it("only removes the targeted parent, leaving others intact", () => {
    recordSpawnOverload("parent-D");
    recordSpawnOverload("parent-E");
    clearSpawnOverloadStreak("parent-D");

    expect(spawnOverloadStreaks.has("parent-D")).toBe(false);
    expect(spawnOverloadStreaks.get("parent-E")).toBe(1);
  });

  it("clears the '' key for null parent", () => {
    recordSpawnOverload(null);
    clearSpawnOverloadStreak(null);
    expect(spawnOverloadStreaks.has("")).toBe(false);
  });

  it("after clearing, the next recordSpawnOverload starts back at 1", () => {
    recordSpawnOverload("parent-F");
    recordSpawnOverload("parent-F");
    clearSpawnOverloadStreak("parent-F");
    const count = recordSpawnOverload("parent-F");
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("getSpawnThrottleStreakLimit", () => {
  it("returns the default limit (5) when no config file exists", () => {
    expect(getSpawnThrottleStreakLimit()).toBe(5);
  });

  it("returns the value from config when spawnThrottleStreakLimit is set", () => {
    moduleConfig.save({
      modules: {},
      system: { spawnThrottleStreakLimit: 3 },
    } as any);
    expect(getSpawnThrottleStreakLimit()).toBe(3);
  });

  it("returns the default (5) when system config exists but omits the key", () => {
    moduleConfig.save({
      modules: {},
      system: { cpuLoadThreshold: 0.9 },
    } as any);
    expect(getSpawnThrottleStreakLimit()).toBe(5);
  });
});
