// Coverage for the touch() ⇄ cleanStale() interaction in
// daemon/connection-registry.ts.
//
// The sibling connection-registry.test.ts pins touch() (updates lastActivity)
// and cleanStale() (drops connections older than 5 min) in isolation, but never
// the integration between them — which is the entire reason touch() exists: a
// connection that would otherwise be reaped as stale must SURVIVE once touched.
//
// Deterministic without fake timers: the test backdates lastActivity to 6 min
// ago (well past the 5-min STALE_MS), then touch() rewrites it to the real
// "now" (new Date().toISOString()), so cleanStale()'s `now - lastActivity` is
// ≈0 ms — unambiguously inside the window regardless of wall-clock jitter.
import { describe, it, expect, afterEach } from "vitest";
import * as registry from "@zana-ai/core/src/daemon/connection-registry.ts";

let registered: string[] = [];

afterEach(() => {
  for (const id of registered) registry.unregister(id);
  registered = [];
});

describe("connection-registry — touch() rescues a connection from cleanStale()", () => {
  it("a stale connection survives cleanStale() after being touched", () => {
    const id = registry.register("mcp");
    registered.push(id);

    // Backdate to 6 minutes ago → would be reaped as stale.
    const conn = registry.list().find((c) => c.id === id) as any;
    conn.lastActivity = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    // touch() refreshes lastActivity to ~now.
    registry.touch(id);

    const removed = registry.cleanStale();

    // The touched connection must not be among those reaped, and must remain.
    expect(registry.list().find((c) => c.id === id)).toBeDefined();
    // It contributed 0 to the removal count (other suites may register too, so
    // assert on the survivor directly rather than removed === 0).
    expect(typeof removed).toBe("number");
  });

  it("without touch() the same backdated connection IS reaped", () => {
    const id = registry.register("mcp");
    registered.push(id);

    const conn = registry.list().find((c) => c.id === id) as any;
    conn.lastActivity = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    const removed = registry.cleanStale();

    expect(registry.list().find((c) => c.id === id)).toBeUndefined();
    expect(removed).toBeGreaterThanOrEqual(1);
    registered = registered.filter((r) => r !== id); // already cleaned
  });
});
