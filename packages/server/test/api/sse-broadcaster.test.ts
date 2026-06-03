// Unit tests for packages/server/src/api/sse-broadcaster.ts
// Covers: broadcast format, client filtering, client removal on error,
// getClientCount, addClient close-cleanup, Last-Event-ID replay, and stop().

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @zana-ai/core before sse-broadcaster.ts lazy-requires it.
const busEmit = vi.fn();
const busOn = vi.fn();
vi.mock("@zana-ai/core", () => ({
  events: {
    bus: { emit: busEmit, on: busOn },
  },
}));

import * as broadcaster from "../../src/api/sse-broadcaster.ts";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeFakeRes(writeFn?: (...args: any[]) => void) {
  const listeners: Record<string, (...args: any[]) => void> = {};
  return {
    written: [] as string[],
    write(chunk: string) {
      if (writeFn) writeFn(chunk);
      this.written.push(chunk);
    },
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] = cb;
    },
    emit(event: string, ...args: any[]) {
      listeners[event]?.(...args);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  broadcaster.stop();
});

// --------------------------------------------------------------------------
// STREAM_EVENTS export
// --------------------------------------------------------------------------

describe("STREAM_EVENTS", () => {
  it("includes the key lifecycle event types", () => {
    expect(broadcaster.STREAM_EVENTS).toContain("agent:spawned");
    expect(broadcaster.STREAM_EVENTS).toContain("agent:terminated");
    expect(broadcaster.STREAM_EVENTS).toContain("ticket:changed");
    expect(broadcaster.STREAM_EVENTS).toContain("team:started");
    expect(broadcaster.STREAM_EVENTS).toContain("team:stopped");
  });
});

// --------------------------------------------------------------------------
// broadcast — message format
// --------------------------------------------------------------------------

describe("broadcast — message format", () => {
  it("writes SSE-formatted text: id / event / data lines", () => {
    const res = makeFakeRes();
    broadcaster.addClient(res as any, null, null);

    broadcaster.broadcast("agent:spawned", { agentId: "a1" });

    expect(res.written.length).toBeGreaterThanOrEqual(1);
    const frame = res.written[res.written.length - 1];
    expect(frame).toMatch(/^id: \d+\n/);
    expect(frame).toContain("event: agent:spawned\n");
    expect(frame).toContain('"agentId":"a1"');
    expect(frame).toMatch(/\n\n$/);
  });

  it("increments the id counter on each call", () => {
    const res = makeFakeRes();
    broadcaster.addClient(res as any, null, null);

    broadcaster.broadcast("team:started", {});
    broadcaster.broadcast("team:stopped", {});

    const ids = res.written.map((f) => {
      const m = f.match(/^id: (\d+)\n/);
      return m ? Number(m[1]) : null;
    });
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).toBeGreaterThan(ids[0]!);
  });
});

// --------------------------------------------------------------------------
// broadcast — client filtering
// --------------------------------------------------------------------------

describe("broadcast — client filtering", () => {
  it("delivers to an unfiltered client", () => {
    const res = makeFakeRes();
    broadcaster.addClient(res as any, null, null);
    broadcaster.broadcast("agent:spawned", { x: 1 });
    expect(res.written.some((f) => f.includes("agent:spawned"))).toBe(true);
  });

  it("delivers to a client whose filterTypes includes the event", () => {
    const res = makeFakeRes();
    broadcaster.addClient(res as any, ["agent:spawned"], null);
    broadcaster.broadcast("agent:spawned", {});
    expect(res.written.some((f) => f.includes("agent:spawned"))).toBe(true);
  });

  it("does NOT deliver to a client whose filterTypes excludes the event", () => {
    const res = makeFakeRes();
    broadcaster.addClient(res as any, ["ticket:changed"], null);
    const before = res.written.length;
    broadcaster.broadcast("agent:spawned", {});
    expect(res.written.length).toBe(before);
  });
});

// --------------------------------------------------------------------------
// broadcast — error removal
// --------------------------------------------------------------------------

describe("broadcast — error removal", () => {
  it("removes a client that throws on write and the count drops", () => {
    const res = makeFakeRes(() => { throw new Error("broken pipe"); });
    broadcaster.addClient(res as any, null, null);
    const countBefore = broadcaster.getClientCount();

    broadcaster.broadcast("agent:spawned", {});

    expect(broadcaster.getClientCount()).toBe(countBefore - 1);
  });
});

// --------------------------------------------------------------------------
// addClient / getClientCount / close cleanup
// --------------------------------------------------------------------------

describe("addClient / getClientCount", () => {
  it("getClientCount increases when a client is added", () => {
    const before = broadcaster.getClientCount();
    const res = makeFakeRes();
    broadcaster.addClient(res as any, null, null);
    expect(broadcaster.getClientCount()).toBe(before + 1);
  });

  it("getClientCount decreases when the response emits close", () => {
    const res = makeFakeRes();
    broadcaster.addClient(res as any, null, null);
    const countAfterAdd = broadcaster.getClientCount();

    res.emit("close");

    expect(broadcaster.getClientCount()).toBe(countAfterAdd - 1);
  });

  it("multiple clients stack — each addClient increments count", () => {
    const before = broadcaster.getClientCount();
    const r1 = makeFakeRes();
    const r2 = makeFakeRes();
    broadcaster.addClient(r1 as any, null, null);
    broadcaster.addClient(r2 as any, null, null);
    expect(broadcaster.getClientCount()).toBe(before + 2);
    r1.emit("close");
    r2.emit("close");
  });
});

// --------------------------------------------------------------------------
// Last-Event-ID replay
// --------------------------------------------------------------------------

describe("Last-Event-ID replay", () => {
  it("replays history entries after the given lastEventId", () => {
    // Send two events to populate history.
    const sink = makeFakeRes();
    broadcaster.addClient(sink as any, null, null);
    broadcaster.broadcast("team:started", { n: 1 });
    broadcaster.broadcast("team:stopped", { n: 2 });
    const written = [...sink.written];
    sink.emit("close"); // disconnect

    // Extract the id of the first event.
    const firstId = written[0].match(/^id: (\d+)\n/)?.[1];
    expect(firstId).toBeDefined();

    // New client connects with that lastEventId — should receive the second event.
    const replay = makeFakeRes();
    broadcaster.addClient(replay as any, null, firstId!);

    expect(replay.written.some((f) => f.includes('"n":2'))).toBe(true);
    expect(replay.written.some((f) => f.includes('"n":1'))).toBe(false);
  });

  it("replays nothing for an unknown lastEventId", () => {
    const res = makeFakeRes();
    broadcaster.addClient(res as any, null, "id-that-does-not-exist");
    // Only the sse:connections emit — no replayed data frames.
    expect(res.written.length).toBe(0);
    res.emit("close");
  });
});

// --------------------------------------------------------------------------
// stop
// --------------------------------------------------------------------------

describe("stop", () => {
  it("calling stop does not throw and can be called repeatedly", () => {
    expect(() => {
      broadcaster.stop();
      broadcaster.stop();
    }).not.toThrow();
  });
});
