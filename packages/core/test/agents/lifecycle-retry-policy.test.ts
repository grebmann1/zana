// Unit tests for lifecycle's transient-error retry POLICY surface:
// getTransientRetryMaxAttempts() and getTransientRetryBackoffMs(). These gate
// whether a transiently-failed headless worker is re-spawned with `--resume`
// and how long the daemon backs off between attempts. The documented invariant
// (lifecycle.ts) is: defaults of 3 attempts and a 30s / 2m / 8m ladder, with
// attempts beyond the ladder clamped to the last rung. The values come from
// module-config, so config overrides must flow through.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  getTransientRetryMaxAttempts,
  getTransientRetryBackoffMs,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

// Point module-config at a fresh tmp file so reads resolve against an
// in-test config (and the baked-in DEFAULTS) rather than the real workspace.
beforeAll(() => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zana-retry-policy-"));
  moduleConfig.setConfigPath(path.join(tmp, "config.json"));
});

// Each test sets the config it needs; reset to the defaults afterward so an
// override (e.g. maxAttempts=0) can't leak into a sibling test.
afterEach(() => {
  moduleConfig.save({ modules: {}, system: {} } as any);
});

describe("getTransientRetryMaxAttempts", () => {
  it("defaults to 3 attempts when system config is unset", () => {
    moduleConfig.save({ modules: {}, system: {} } as any);
    expect(getTransientRetryMaxAttempts()).toBe(3);
  });

  it("honors a configured override, including 0 (retries disabled)", () => {
    moduleConfig.save({ modules: {}, system: { transientRetryMaxAttempts: 0 } } as any);
    expect(getTransientRetryMaxAttempts()).toBe(0);
  });

  it("rejects a negative override and falls back to the default", () => {
    moduleConfig.save({ modules: {}, system: { transientRetryMaxAttempts: -1 } } as any);
    expect(getTransientRetryMaxAttempts()).toBe(3);
  });
});

describe("getTransientRetryBackoffMs — default 30s / 2m / 8m ladder", () => {
  beforeAll(() => {
    moduleConfig.save({ modules: {}, system: {} } as any);
  });

  it("returns each rung by 0-based attempt index", () => {
    expect(getTransientRetryBackoffMs(0)).toBe(30_000);
    expect(getTransientRetryBackoffMs(1)).toBe(120_000);
    expect(getTransientRetryBackoffMs(2)).toBe(480_000);
  });

  it("clamps attempts beyond the ladder to the last rung", () => {
    expect(getTransientRetryBackoffMs(3)).toBe(480_000);
    expect(getTransientRetryBackoffMs(99)).toBe(480_000);
  });
});

describe("getTransientRetryBackoffMs — config override", () => {
  it("uses a configured ladder and still clamps past its end", () => {
    moduleConfig.save({
      modules: {},
      system: { transientRetryBackoffMs: [1000, 2000] },
    } as any);
    expect(getTransientRetryBackoffMs(0)).toBe(1000);
    expect(getTransientRetryBackoffMs(1)).toBe(2000);
    expect(getTransientRetryBackoffMs(5)).toBe(2000);
  });

  it("falls back to the default ladder when the override is empty", () => {
    moduleConfig.save({
      modules: {},
      system: { transientRetryBackoffMs: [] },
    } as any);
    expect(getTransientRetryBackoffMs(0)).toBe(30_000);
    expect(getTransientRetryBackoffMs(2)).toBe(480_000);
  });
});
