import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { bus } from "@zana-ai/core/src/events/bus.ts";
import * as registry from "@zana-ai/core/src/daemon/connection-registry.ts";

// The registry stores state in a module-level Map.  We track registered ids
// per test so each test can clean up after itself.

let registered: string[] = [];

function reg(type: string, meta?: object): string {
  const id = registry.register(type, meta);
  registered.push(id);
  return id;
}

beforeEach(() => {
  registered = [];
  vi.spyOn(bus, "emit");
});

afterEach(() => {
  // Clean up any connections this test registered.
  for (const id of registered) registry.unregister(id);
  registered = [];
  vi.restoreAllMocks();
});

// ─── register ────────────────────────────────────────────────────────────────

describe("register()", () => {
  it("returns a non-empty string id", () => {
    const id = reg("mcp");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("emits connection:opened with connectionId and type", () => {
    const id = reg("mcp");
    expect(bus.emit).toHaveBeenCalledWith("connection:opened", {
      connectionId: id,
      type: "mcp",
    });
  });

  it("stores connection with correct type and meta fields", () => {
    const id = reg("http", { user: "alice" });
    const found = registry.list().find((c) => c.id === id);
    expect(found).toBeDefined();
    expect(found!.type).toBe("http");
    expect((found as any).user).toBe("alice");
  });

  it("each call returns a unique id", () => {
    const a = reg("x");
    const b = reg("x");
    expect(a).not.toBe(b);
  });
});

// ─── unregister ──────────────────────────────────────────────────────────────

describe("unregister()", () => {
  it("removes the connection from the list", () => {
    const id = reg("mcp");
    registry.unregister(id);
    registered = registered.filter((r) => r !== id); // already removed
    expect(registry.list().find((c) => c.id === id)).toBeUndefined();
  });

  it("emits connection:closed with connectionId and type", () => {
    const id = reg("ws");
    vi.clearAllMocks(); // reset spy after register call
    registry.unregister(id);
    registered = registered.filter((r) => r !== id);
    expect(bus.emit).toHaveBeenCalledWith("connection:closed", {
      connectionId: id,
      type: "ws",
    });
  });

  it("is a no-op for an unknown id (no throw, no event)", () => {
    registry.unregister("does-not-exist");
    expect(bus.emit).not.toHaveBeenCalledWith(
      "connection:closed",
      expect.anything()
    );
  });
});

// ─── getCount / getByType ────────────────────────────────────────────────────

describe("getCount()", () => {
  it("reflects the number of active connections", () => {
    const before = registry.getCount();
    const a = reg("mcp");
    const b = reg("mcp");
    expect(registry.getCount()).toBe(before + 2);
    registry.unregister(a);
    registered = registered.filter((r) => r !== a);
    expect(registry.getCount()).toBe(before + 1);
    registry.unregister(b);
    registered = registered.filter((r) => r !== b);
    expect(registry.getCount()).toBe(before);
  });
});

describe("getByType()", () => {
  it("returns only connections of the requested type", () => {
    const a = reg("mcp");
    const b = reg("http");
    const mcps = registry.getByType("mcp").map((c) => c.id);
    expect(mcps).toContain(a);
    expect(mcps).not.toContain(b);
  });
});

// ─── touch ───────────────────────────────────────────────────────────────────

describe("touch()", () => {
  it("updates lastActivity to a later timestamp", async () => {
    const id = reg("mcp");
    const before = registry.list().find((c) => c.id === id)!.lastActivity;
    // Advance real time by at least 1 ms
    await new Promise((r) => setTimeout(r, 5));
    registry.touch(id);
    const after = registry.list().find((c) => c.id === id)!.lastActivity;
    expect(new Date(after).getTime()).toBeGreaterThan(
      new Date(before).getTime()
    );
  });

  it("is a no-op for unknown id (no throw)", () => {
    expect(() => registry.touch("ghost")).not.toThrow();
  });
});

// ─── cleanStale ──────────────────────────────────────────────────────────────

describe("cleanStale()", () => {
  it("removes connections whose lastActivity is older than 5 minutes", () => {
    const id = reg("mcp");

    // Manually backdate lastActivity to simulate staleness.
    const conn = registry.list().find((c) => c.id === id) as any;
    conn.lastActivity = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    const removed = registry.cleanStale();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(registry.list().find((c) => c.id === id)).toBeUndefined();
    registered = registered.filter((r) => r !== id); // already cleaned
  });

  it("keeps connections that are within the 5-minute window", () => {
    const id = reg("mcp");
    const removed = registry.cleanStale();
    expect(registry.list().find((c) => c.id === id)).toBeDefined();
    expect(removed).toBe(0);
  });
});
