import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bus } from "@zana-ai/contracts";
import * as registry from "@zana-ai/core/src/daemon/connection-registry.ts";

// Focused coverage for cleanStale()'s SELECTIVE behavior over a MIXED set.
//
// The existing connection-registry suite only exercises cleanStale() against
// a uniform population (all fresh → removes 0, or one back-dated entry →
// removes >=1). Neither pins the two invariants that actually matter for a
// pruning routine:
//   1. In a single sweep over fresh + stale connections it removes EXACTLY
//      the stale ones and leaves the fresh ones untouched.
//   2. The cutoff is strict `age > STALE_MS` (5 min): an entry just inside
//      the window survives while one just past it is reaped.
//
// connection-registry stores state in a module-level Map, so we register
// real connections and back-date `lastActivity` on the live objects (the
// same technique the existing cleanStale test uses). Back-dating by whole
// seconds keeps the just-inside-window case immune to the few ms that elapse
// before cleanStale() reads Date.now(), so the test stays deterministic.

let registered: string[] = [];

function reg(type: string): string {
  const id = registry.register(type);
  registered.push(id);
  return id;
}

function backdate(id: string, msAgo: number): void {
  const conn = registry.list().find((c) => c.id === id) as any;
  conn.lastActivity = new Date(Date.now() - msAgo).toISOString();
}

beforeEach(() => {
  registered = [];
  vi.spyOn(bus, "emit");
});

afterEach(() => {
  for (const id of registered) registry.unregister(id);
  registered = [];
  vi.restoreAllMocks();
});

describe("cleanStale() over a mixed fresh/stale population", () => {
  const FIVE_MIN = 5 * 60 * 1000;

  it("removes only the stale connections and returns their exact count", () => {
    const fresh = reg("mcp"); // age ~0
    const justInside = reg("http"); // 4m59s — strictly inside the window
    const stale1 = reg("ws"); // 6m — stale
    const stale2 = reg("mcp"); // 10m — stale

    backdate(justInside, FIVE_MIN - 1000);
    backdate(stale1, 6 * 60 * 1000);
    backdate(stale2, 10 * 60 * 1000);

    const before = registry.getCount();
    const removed = registry.cleanStale();

    // Exactly the two back-dated-past-the-window entries were reaped.
    expect(removed).toBe(2);
    expect(registry.getCount()).toBe(before - 2);

    const ids = registry.list().map((c) => c.id);
    expect(ids).toContain(fresh);
    expect(ids).toContain(justInside); // survives the strict `> STALE_MS` cutoff
    expect(ids).not.toContain(stale1);
    expect(ids).not.toContain(stale2);

    // Drop the reaped ids so afterEach doesn't re-unregister them.
    registered = registered.filter((r) => r !== stale1 && r !== stale2);
  });
});
