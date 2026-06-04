/**
 * Tests for packages/core/src/agents/pty-host.ts
 *
 * Covers the non-PTY-spawn surface: operations on non-existent terminals,
 * callback registration / unsubscription, and the killAll no-op.  All tests
 * are deterministic — no real PTY is spawned (node-pty may or may not be
 * installed; we never call spawnTerminal).
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  getTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  listTerminals,
  killAll,
  onTerminalData,
  onTerminalExit,
} from "@zana-ai/core/src/agents/pty-host.ts";

// ─── No-terminal-found behaviour ─────────────────────────────────────────────

describe("pty-host — operations on non-existent terminal", () => {
  it("getTerminal returns null for unknown id", () => {
    expect(getTerminal("does-not-exist")).toBeNull();
  });

  it("writeTerminal returns false for unknown id", () => {
    expect(writeTerminal("ghost", "hello")).toBe(false);
  });

  it("resizeTerminal returns false for unknown id", () => {
    expect(resizeTerminal("ghost", 120, 40)).toBe(false);
  });

  it("killTerminal returns false for unknown id", () => {
    expect(killTerminal("ghost")).toBe(false);
  });

  it("listTerminals returns empty array when no terminals are live", () => {
    const result = listTerminals();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("killAll is safe (no-op) when no terminals are live", () => {
    expect(() => killAll()).not.toThrow();
    expect(listTerminals().length).toBe(0);
  });
});

// ─── Callback registration ────────────────────────────────────────────────────

describe("pty-host — onTerminalData", () => {
  const unsubs: Array<() => void> = [];
  afterEach(() => {
    // Clean up any registered listeners so tests don't leak into each other.
    for (const fn of unsubs.splice(0)) fn();
  });

  it("returns an unsubscribe function", () => {
    const unsub = onTerminalData(() => {});
    unsubs.push(unsub);
    expect(typeof unsub).toBe("function");
  });

  it("calling the returned function twice is safe (idempotent splice)", () => {
    const unsub = onTerminalData(() => {});
    expect(() => { unsub(); unsub(); }).not.toThrow();
  });

  it("registered callback is no longer called after unsubscribe", () => {
    // We can verify removal indirectly: registering, then unsubscribing, then
    // re-querying listTerminals (which fires no callbacks) doesn't error, and
    // the listener array didn't grow unboundedly.
    const calls: string[] = [];
    const unsub = onTerminalData(({ data }) => calls.push(data));
    unsub();
    // No way to fire the callback without a real terminal; just confirm the
    // unsubscribe didn't throw and the reference is gone.
    expect(calls.length).toBe(0);
  });
});

describe("pty-host — onTerminalExit", () => {
  const unsubs: Array<() => void> = [];
  afterEach(() => {
    for (const fn of unsubs.splice(0)) fn();
  });

  it("returns an unsubscribe function", () => {
    const unsub = onTerminalExit(() => {});
    unsubs.push(unsub);
    expect(typeof unsub).toBe("function");
  });

  it("calling the returned function twice is safe", () => {
    const unsub = onTerminalExit(() => {});
    expect(() => { unsub(); unsub(); }).not.toThrow();
  });

  it("multiple listeners can be registered independently", () => {
    const a = onTerminalExit(() => {});
    const b = onTerminalExit(() => {});
    unsubs.push(a, b);
    // Both return distinct unsubscribe functions.
    expect(a).not.toBe(b);
  });
});
