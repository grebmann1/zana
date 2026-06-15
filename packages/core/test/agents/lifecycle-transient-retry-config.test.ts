// Unit tests for the transient-retry tunables in agents/lifecycle.ts:
//   getTransientRetryMaxAttempts()  -> attempt ceiling
//   getTransientRetryBackoffMs(n)   -> backoff ladder lookup with clamping
//
// Both read from moduleConfig.get()?.system and fall back to hard defaults
// (3 attempts; [30s, 2m, 8m] ladder) when config is missing or invalid.
//
// Strategy: mock ../modules/config so get() returns a value we control per
// test. No disk, no timers, no real Claude — fully deterministic.

import { describe, it, expect, beforeEach, vi } from "vitest";

let fakeConfig: any = null;

vi.mock("@zana-ai/core/src/modules/config.ts", () => ({
  get: () => fakeConfig,
}));

import {
  getTransientRetryMaxAttempts,
  getTransientRetryBackoffMs,
} from "@zana-ai/core/src/agents/lifecycle.ts";

const DEFAULT_MAX = 3;
const DEFAULT_LADDER = [30_000, 120_000, 480_000];

describe("getTransientRetryMaxAttempts", () => {
  beforeEach(() => {
    fakeConfig = null;
  });

  it("returns the default when config is missing", () => {
    fakeConfig = null;
    expect(getTransientRetryMaxAttempts()).toBe(DEFAULT_MAX);
  });

  it("returns the default when system.transientRetryMaxAttempts is absent", () => {
    fakeConfig = { system: {} };
    expect(getTransientRetryMaxAttempts()).toBe(DEFAULT_MAX);
  });

  it("returns a configured non-negative override", () => {
    fakeConfig = { system: { transientRetryMaxAttempts: 5 } };
    expect(getTransientRetryMaxAttempts()).toBe(5);
  });

  it("accepts 0 (retries disabled) as a valid override", () => {
    fakeConfig = { system: { transientRetryMaxAttempts: 0 } };
    expect(getTransientRetryMaxAttempts()).toBe(0);
  });

  it("falls back to the default on a negative or non-numeric value", () => {
    fakeConfig = { system: { transientRetryMaxAttempts: -1 } };
    expect(getTransientRetryMaxAttempts()).toBe(DEFAULT_MAX);
    fakeConfig = { system: { transientRetryMaxAttempts: "lots" } };
    expect(getTransientRetryMaxAttempts()).toBe(DEFAULT_MAX);
  });
});

describe("getTransientRetryBackoffMs", () => {
  beforeEach(() => {
    fakeConfig = null;
  });

  it("walks the default ladder by attempt index", () => {
    fakeConfig = null;
    expect(getTransientRetryBackoffMs(0)).toBe(DEFAULT_LADDER[0]);
    expect(getTransientRetryBackoffMs(1)).toBe(DEFAULT_LADDER[1]);
    expect(getTransientRetryBackoffMs(2)).toBe(DEFAULT_LADDER[2]);
  });

  it("clamps attempts beyond the ladder to the last rung", () => {
    fakeConfig = null;
    expect(getTransientRetryBackoffMs(3)).toBe(DEFAULT_LADDER[2]);
    expect(getTransientRetryBackoffMs(99)).toBe(DEFAULT_LADDER[2]);
  });

  it("uses a configured ladder when provided", () => {
    fakeConfig = { system: { transientRetryBackoffMs: [10, 20] } };
    expect(getTransientRetryBackoffMs(0)).toBe(10);
    expect(getTransientRetryBackoffMs(1)).toBe(20);
    // clamps to last configured rung
    expect(getTransientRetryBackoffMs(5)).toBe(20);
  });

  it("falls back to the default ladder when the configured one is empty", () => {
    fakeConfig = { system: { transientRetryBackoffMs: [] } };
    expect(getTransientRetryBackoffMs(0)).toBe(DEFAULT_LADDER[0]);
  });

  it("falls back to the last default rung when the chosen ladder value is invalid", () => {
    fakeConfig = { system: { transientRetryBackoffMs: [-5] } };
    expect(getTransientRetryBackoffMs(0)).toBe(DEFAULT_LADDER[DEFAULT_LADDER.length - 1]);
  });
});
