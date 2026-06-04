// Unit tests for packages/core/src/events/store.ts
//
// Covers:
//   - appendEvent + queryEvents round-trip (happy path)
//   - queryEvents returns [] when file is missing (ENOENT)
//   - queryEvents filtering: types, source, since, workspace, tags
//   - queryEvents limit parameter
//   - compact: trims by retentionCount
//   - compact: trims by retentionMs (age)
//   - compact: returns 0 / is a no-op when file is missing

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as store from "@zana-ai/core/src/events/store.ts";

// Both the .ts source and the compiled dist export the same workspaceContext
// singleton; reset both to avoid cross-test bleed.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-store-test-"));
  // Pre-create .zana/ so resolveProjectDir anchors here instead of walking
  // up to any ancestor .zana/ directory (e.g. /tmp/.zana on macOS).
  fs.mkdirSync(path.join(tmpDir, ".zana"), { recursive: true });
  initWorkspace(tmpDir);
});

afterEach(() => {
  resetWorkspace();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    type: "test:event",
    source: "test-source",
    workspace: tmpDir,
    timestamp: Date.now(),
    tags: [],
    ...overrides,
  };
}

// ─── appendEvent + queryEvents round-trip ───────────────────────────────────

describe("appendEvent + queryEvents", () => {
  it("appended events are returned by queryEvents (happy path)", () => {
    const e1 = makeEvent({ type: "a:event", id: "1" });
    const e2 = makeEvent({ type: "b:event", id: "2" });
    store.appendEvent(e1);
    store.appendEvent(e2);
    const results = store.queryEvents({}, 100);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe("1");
    expect(results[1].id).toBe("2");
  });

  it("returns [] when the events file does not exist (ENOENT)", () => {
    // No appendEvent call — file never created
    const results = store.queryEvents({}, 100);
    expect(results).toEqual([]);
  });
});

// ─── queryEvents filtering ───────────────────────────────────────────────────

describe("queryEvents — filtering", () => {
  beforeEach(() => {
    const now = 1_000_000;
    store.appendEvent(makeEvent({ type: "alpha", source: "src-a", workspace: "ws-a", timestamp: now - 3000, tags: ["x"] }));
    store.appendEvent(makeEvent({ type: "beta",  source: "src-b", workspace: "ws-b", timestamp: now - 2000, tags: ["y"] }));
    store.appendEvent(makeEvent({ type: "alpha", source: "src-b", workspace: "ws-a", timestamp: now - 1000, tags: ["x", "y"] }));
    store.appendEvent(makeEvent({ type: "gamma", source: "src-a", workspace: "ws-b", timestamp: now,        tags: [] }));
  });

  it("filter by types — returns only matching types", () => {
    const r = store.queryEvents({ types: ["alpha"] }, 100);
    expect(r.length).toBe(2);
    expect(r.every((e) => e.type === "alpha")).toBe(true);
  });

  it("filter by types — multiple types act as OR", () => {
    const r = store.queryEvents({ types: ["alpha", "gamma"] }, 100);
    expect(r.length).toBe(3);
  });

  it("filter by types — empty types array returns all events", () => {
    const r = store.queryEvents({ types: [] }, 100);
    expect(r.length).toBe(4);
  });

  it("filter by source", () => {
    const r = store.queryEvents({ source: "src-a" }, 100);
    expect(r.length).toBe(2);
    expect(r.every((e) => e.source === "src-a")).toBe(true);
  });

  it("filter by workspace", () => {
    const r = store.queryEvents({ workspace: "ws-b" }, 100);
    expect(r.length).toBe(2);
    expect(r.every((e) => e.workspace === "ws-b")).toBe(true);
  });

  it("filter by since — returns events with timestamp >= cutoff", () => {
    const r = store.queryEvents({ since: 1_000_000 - 1500 }, 100);
    // timestamps: now-3000, now-2000, now-1000, now
    // cutoff = now-1500 → keeps now-1000 and now
    expect(r.length).toBe(2);
  });

  it("filter by tags — returns events that include ANY of the requested tags", () => {
    const r = store.queryEvents({ tags: ["y"] }, 100);
    // beta has [y], alpha-2 has [x,y] → 2 events
    expect(r.length).toBe(2);
    expect(r.every((e) => e.tags.includes("y"))).toBe(true);
  });

  it("filters can be combined (source + types)", () => {
    const r = store.queryEvents({ source: "src-b", types: ["alpha"] }, 100);
    expect(r.length).toBe(1);
    expect(r[0].source).toBe("src-b");
    expect(r[0].type).toBe("alpha");
  });

  it("limit parameter caps the returned set (most-recent wins)", () => {
    const r = store.queryEvents({}, 2);
    expect(r.length).toBe(2);
    // slice(-2) → the two most recent events
    expect(r[0].type).toBe("alpha"); // now-1000
    expect(r[1].type).toBe("gamma"); // now
  });
});

// ─── compact ────────────────────────────────────────────────────────────────

describe("compact", () => {
  it("trims events to retentionCount (keeps the most-recent N)", () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      store.appendEvent(makeEvent({ id: String(i), timestamp: base + i }));
    }
    const kept = store.compact({ retentionCount: 3, retentionMs: 999_999_999 });
    expect(kept).toBe(3);
    const remaining = store.queryEvents({}, 100);
    expect(remaining.length).toBe(3);
    // The retained events should be the three most-recent (ids 2, 3, 4)
    expect(remaining.map((e) => e.id)).toEqual(["2", "3", "4"]);
  });

  it("trims events older than retentionMs", () => {
    const now = Date.now();
    store.appendEvent(makeEvent({ id: "old", timestamp: now - 10_000 }));
    store.appendEvent(makeEvent({ id: "new", timestamp: now }));
    const kept = store.compact({ retentionCount: 9999, retentionMs: 5_000 });
    // Only 'new' is within the 5-second window
    expect(kept).toBe(1);
    const remaining = store.queryEvents({}, 100);
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe("new");
  });

  it("returns 0 when the events file does not exist (ENOENT)", () => {
    const result = store.compact({ retentionCount: 100, retentionMs: 86400000 });
    expect(result).toBe(0);
  });
});
