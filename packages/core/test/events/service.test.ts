// Unit tests for packages/core/src/events/service.ts
//
// Covers:
//   - subscribe() + emit() delivers events to registered callbacks
//   - unsub() function removes the subscriber
//   - stop() clears all subscribers so no further callbacks fire
//   - type filter: only events matching `filter.types` reach the callback
//   - source filter: only events from matching source reach the callback
//   - tags filter: only events containing a matching tag reach the callback
//   - subscriber errors do not propagate to the emitter

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as service from "@zana-ai/core/src/events/service.ts";

// Reset both the .ts source singleton and the compiled-dist singleton to avoid
// cross-test workspace bleed (mirrors the pattern in store.test.ts).
const wcDist: any = (core as any).project.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

function initWorkspace(root: string) {
  workspaceContextTs.init(root);
  wcDist.init(root);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-svc-test-"));
  // Pre-create .zana/ so resolveProjectDir anchors here instead of walking
  // up to any ancestor .zana/ directory (e.g. /tmp/.zana on macOS/CI).
  fs.mkdirSync(path.join(tmpDir, ".zana"), { recursive: true });
  initWorkspace(tmpDir);
  // init() is idempotent: only the first call per process monkey-patches
  // bus.emit. Subsequent beforeEach calls are no-ops, which is fine —
  // stop() in afterEach clears the subscribers list between tests.
  service.init();
});

afterEach(() => {
  service.stop();
  resetWorkspace();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ─── subscribe + emit ────────────────────────────────────────────────────────

describe("events/service — subscribe + emit", () => {
  it("delivers emitted events to a registered subscriber", () => {
    const received: any[] = [];
    service.subscribe({ types: ["test:ping"] }, (ev) => received.push(ev));
    service.emit("test:ping", { value: 42 }, []);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("test:ping");
    expect(received[0].payload.value).toBe(42);
  });

  it("unsub function removes the subscriber before the next emit", () => {
    const received: any[] = [];
    const unsub = service.subscribe(null, (ev) => received.push(ev));

    service.emit("test:event", {}, []);
    expect(received).toHaveLength(1);

    unsub();
    service.emit("test:event", {}, []);
    expect(received).toHaveLength(1); // no new event after unsub
  });

  it("multiple subscribers each receive the event independently", () => {
    const a: any[] = [];
    const b: any[] = [];
    service.subscribe(null, (ev) => a.push(ev));
    service.subscribe(null, (ev) => b.push(ev));

    service.emit("test:broadcast", { x: 1 }, []);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

// ─── stop() ──────────────────────────────────────────────────────────────────

describe("events/service — stop()", () => {
  it("prevents further events from reaching subscribers after stop", () => {
    const received: any[] = [];
    service.subscribe(null, (ev) => received.push(ev));

    service.emit("test:before", {}, []);
    expect(received).toHaveLength(1);

    service.stop();
    service.emit("test:after", {}, []);
    expect(received).toHaveLength(1); // still 1 — no events after stop
  });
});

// ─── filter matching ─────────────────────────────────────────────────────────

describe("events/service — filter: types", () => {
  it("only delivers events whose type is in filter.types", () => {
    const received: any[] = [];
    service.subscribe({ types: ["wanted:event"] }, (ev) => received.push(ev));

    service.emit("ignored:event", { n: 1 }, []);
    service.emit("wanted:event", { n: 2 }, []);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("wanted:event");
  });

  it("null filter matches all event types", () => {
    const received: any[] = [];
    service.subscribe(null, (ev) => received.push(ev));

    service.emit("any:type:a", {}, []);
    service.emit("any:type:b", {}, []);

    expect(received).toHaveLength(2);
  });
});

describe("events/service — filter: source", () => {
  it("only delivers events from the matching source (agentId)", () => {
    const received: any[] = [];
    service.subscribe({ source: "agent-X" }, (ev) => received.push(ev));

    // source is derived from payload.agentId in capture()
    service.emit("any:event", { agentId: "agent-Y" }, []);
    service.emit("any:event", { agentId: "agent-X" }, []);

    expect(received).toHaveLength(1);
    expect(received[0].source).toBe("agent-X");
  });
});

describe("events/service — filter: tags", () => {
  it("only delivers events that carry a matching tag", () => {
    const received: any[] = [];
    service.subscribe({ tags: ["priority"] }, (ev) => received.push(ev));

    // tags are passed as the third argument to emit() and land in event.tags
    service.emit("any:event", {}, ["unrelated"]);
    service.emit("any:event", {}, ["priority"]);

    expect(received).toHaveLength(1);
    expect(received[0].tags).toContain("priority");
  });
});

// ─── error isolation ─────────────────────────────────────────────────────────

describe("events/service — subscriber error isolation", () => {
  it("a throwing subscriber does not propagate the error to the emitter", () => {
    service.subscribe(null, () => {
      throw new Error("subscriber blew up");
    });

    expect(() => service.emit("test:event", {}, [])).not.toThrow();
  });

  it("a throwing subscriber does not prevent a later subscriber from firing", () => {
    const received: any[] = [];
    service.subscribe(null, () => { throw new Error("first subscriber throws"); });
    service.subscribe(null, (ev) => received.push(ev));

    expect(() => service.emit("test:event", {}, [])).not.toThrow();
    expect(received).toHaveLength(1);
  });
});
