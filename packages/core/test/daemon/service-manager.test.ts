// Unit tests for packages/core/src/daemon/service-manager.ts
//
// service-manager.ts is a CJS module whose internal require() calls bypass
// Vitest's vi.mock infrastructure in SSR mode. We therefore test only the
// behaviours that are safe and observable without injecting mocks:
//
//   1. backend() dispatch — throws on unsupported platform
//   2. status() result shape — always returns { installed, running, pid }
//   3. logs() result — always returns a string (never throws)
//
// We intentionally do NOT call install() or uninstall() — those invoke real
// launchctl / systemctl and write to ~/.  The dispatch-throw test covers the
// only purely-logic path reachable without side-effects.

import { describe, it, expect } from "vitest";

// CJS module — surfaces as named module.exports props under Vite SSR mode.
import * as svc from "@zana-ai/core/src/daemon/service-manager.ts";
const sm = svc as any;

// ── 1. Platform dispatch ──────────────────────────────────────────────────────

describe("backend() — platform dispatch", () => {
  it("throws containing 'Unsupported platform' when process.platform is not darwin or linux", () => {
    const origPlatform = process.platform;
    // win32 is not handled by either backend
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      // All four exported functions call backend() internally.
      expect(() => sm.status()).toThrow(/Unsupported platform/i);
    } finally {
      Object.defineProperty(process, "platform", {
        value: origPlatform,
        configurable: true,
      });
    }
  });

  it("does NOT throw for darwin or linux platforms", () => {
    // On the host machine process.platform is already darwin or linux —
    // calling status() should not throw with 'Unsupported platform'.
    // (It may throw/return for other reasons but not the dispatch guard.)
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    // status() is the safest exported call (read-only).
    // We only care that it doesn't throw the dispatch error.
    let threw = false;
    try {
      sm.status();
    } catch (err: any) {
      if (/Unsupported platform/i.test(err?.message ?? "")) threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ── 2. status() result shape ─────────────────────────────────────────────────

describe("status() — result shape", () => {
  it("returns an object with installed, running, and pid fields", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    const result = sm.status();
    expect(result).toBeTypeOf("object");
    expect(result).not.toBeNull();
    expect("installed" in result).toBe(true);
    expect("running" in result).toBe(true);
    expect("pid" in result).toBe(true);
  });

  it("installed is a boolean", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    const result = sm.status();
    expect(typeof result.installed).toBe("boolean");
  });

  it("running is a boolean", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    const result = sm.status();
    expect(typeof result.running).toBe("boolean");
  });

  it("pid is null or a positive integer", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    const result = sm.status();
    if (result.pid !== null) {
      expect(typeof result.pid).toBe("number");
      expect(result.pid).toBeGreaterThan(0);
      expect(Number.isInteger(result.pid)).toBe(true);
    }
  });

  it("running is false when installed is false", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    const result = sm.status();
    if (!result.installed) {
      expect(result.running).toBe(false);
    }
  });
});

// ── 3. logs() result ──────────────────────────────────────────────────────────

describe("logs() — result", () => {
  it("returns a string without throwing", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    let result: unknown;
    expect(() => { result = sm.logs(10); }).not.toThrow();
    expect(typeof result).toBe("string");
  });

  it("accepts a line-count argument without throwing", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    expect(() => sm.logs(1)).not.toThrow();
    expect(() => sm.logs(100)).not.toThrow();
  });
});
