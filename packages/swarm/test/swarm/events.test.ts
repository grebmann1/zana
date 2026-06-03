// Tests for swarm/events — ring buffer, query filters, onChange listeners.
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  addEvent,
  query,
  pending,
  clear,
  onChange,
} from "@zana-ai/swarm/src/swarm/events.ts";

beforeEach(() => {
  clear();
});

describe("addEvent", () => {
  it("auto-assigns id and timestamp when omitted", () => {
    addEvent({ type: "ping" });
    const [e] = query();
    expect(typeof e.id).toBe("string");
    expect(e.id.length).toBeGreaterThan(0);
    expect(typeof e.timestamp).toBe("number");
  });

  it("preserves caller-supplied id and timestamp", () => {
    addEvent({ id: "my-id", timestamp: 12345, type: "ping" });
    const [e] = query();
    expect(e.id).toBe("my-id");
    expect(e.timestamp).toBe(12345);
  });

  it("returns all stored events via query()", () => {
    addEvent({ type: "a" });
    addEvent({ type: "b" });
    addEvent({ type: "c" });
    expect(query().length).toBe(3);
  });

  it("enforces ring-buffer cap of 1000 — oldest event dropped", () => {
    for (let i = 0; i < 1001; i++) addEvent({ type: "t", seq: i });
    const all = query();
    expect(all.length).toBe(1000);
    // The very first event (seq=0) should have been evicted.
    expect(all[0].seq).toBe(1);
    expect(all[999].seq).toBe(1000);
  });
});

describe("query filters", () => {
  beforeEach(() => {
    addEvent({ id: "e1", timestamp: 100, daemonId: "d1", type: "start" });
    addEvent({ id: "e2", timestamp: 200, daemonId: "d2", type: "stop" });
    addEvent({ id: "e3", timestamp: 300, daemonId: "d1", type: "stop" });
  });

  it("filters by since (exclusive)", () => {
    const result = query({ since: 100 });
    expect(result.map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  it("filters by daemonId", () => {
    const result = query({ daemonId: "d1" });
    expect(result.map((e) => e.id)).toEqual(["e1", "e3"]);
  });

  it("filters by type", () => {
    const result = query({ type: "stop" });
    expect(result.map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  it("limits to last N events", () => {
    const result = query({ limit: 2 });
    expect(result.map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  it("combines multiple filters", () => {
    const result = query({ daemonId: "d1", type: "stop" });
    expect(result.map((e) => e.id)).toEqual(["e3"]);
  });

  it("returns empty array when no events match", () => {
    expect(query({ daemonId: "nobody" })).toEqual([]);
  });
});

describe("pending", () => {
  it("returns all events when called with no argument", () => {
    addEvent({ type: "x" });
    addEvent({ type: "y" });
    expect(pending(undefined).length).toBe(2);
  });

  it("returns events with timestamp strictly greater than since", () => {
    addEvent({ timestamp: 10, type: "a" });
    addEvent({ timestamp: 20, type: "b" });
    addEvent({ timestamp: 30, type: "c" });
    expect(pending(10).map((e) => e.type)).toEqual(["b", "c"]);
  });
});

describe("onChange listener", () => {
  it("fires the callback each time an event is added", () => {
    const cb = vi.fn();
    const unsub = onChange(cb);
    addEvent({ type: "first" });
    addEvent({ type: "second" });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0][0].type).toBe("first");
    unsub();
  });

  it("unsubscribe removes the listener", () => {
    const cb = vi.fn();
    const unsub = onChange(cb);
    addEvent({ type: "before" });
    unsub();
    addEvent({ type: "after" });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("swallows listener errors so other listeners still fire", () => {
    const bad = vi.fn(() => { throw new Error("oops"); });
    const good = vi.fn();
    const u1 = onChange(bad);
    const u2 = onChange(good);
    expect(() => addEvent({ type: "boom" })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    u1(); u2();
  });
});
