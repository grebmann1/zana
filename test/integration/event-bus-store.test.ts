import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import * as eventBusStore from "@zana-ai/core/src/events/store.ts";
import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";

// Each test bootstraps a temp workspace so writes land inside the test's
// own .zana directory rather than ~/.zana — required by the tenant-isolation
// gate that refuses the global fallback for events writes.

describe("event-bus-store", () => {
  let tmpRoot: string;
  let EVENTS_DIR: string;
  let EVENTS_FILE: string;
  let CONFIG_FILE: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-evt-bus-store-"));
    fs.mkdirSync(path.join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    EVENTS_DIR = path.join(tmpRoot, ".zana", "events");
    EVENTS_FILE = path.join(EVENTS_DIR, "bus-events.ndjson");
    CONFIG_FILE = path.join(EVENTS_DIR, "bus-config.json");
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    try { (workspaceContext as any)._resetForTesting?.(); } catch {}
    try { (core as any).project.workspaceContext._resetForTesting?.(); } catch {}
    void EVENTS_FILE; void CONFIG_FILE; void EVENTS_DIR;
  });

  it("appends and queries events", () => {
    // Clear existing
    try { fs.unlinkSync(EVENTS_FILE); } catch {}

    eventBusStore.appendEvent({
      id: "evt-1",
      type: "test:event",
      source: "test",
      timestamp: Date.now(),
      payload: { foo: "bar" },
      tags: ["test"],
    });

    eventBusStore.appendEvent({
      id: "evt-2",
      type: "other:event",
      source: "other",
      timestamp: Date.now(),
      payload: {},
      tags: [],
    });

    const all = eventBusStore.queryEvents({}, 100);
    expect(all.length).toBe(2);

    const filtered = eventBusStore.queryEvents({ types: ["test:event"] }, 100);
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe("evt-1");

    const bySource = eventBusStore.queryEvents({ source: "other" }, 100);
    expect(bySource.length).toBe(1);
  });

  it("compacts events beyond retention", () => {
    try { fs.unlinkSync(EVENTS_FILE); } catch {}

    const now = Date.now();
    eventBusStore.appendEvent({ id: "old", type: "a", source: "s", timestamp: now - 100000000, payload: {} });
    eventBusStore.appendEvent({ id: "new", type: "b", source: "s", timestamp: now, payload: {} });

    const remaining = eventBusStore.compact({ retentionMs: 86400000, retentionCount: 5000 });
    expect(remaining).toBe(1);

    const events = eventBusStore.queryEvents({}, 100);
    expect(events.length).toBe(1);
    expect(events[0].id).toBe("new");
  });

  it("respects retention count", () => {
    try { fs.unlinkSync(EVENTS_FILE); } catch {}

    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      eventBusStore.appendEvent({ id: `e-${i}`, type: "test", source: "s", timestamp: now, payload: {} });
    }

    const remaining = eventBusStore.compact({ retentionMs: 86400000, retentionCount: 3 });
    expect(remaining).toBe(3);
  });

  it("loads and saves config", () => {
    const config = eventBusStore.loadConfig();
    expect(config.retentionCount).toBe(5000);
    expect(config.retentionMs).toBe(86400000);

    eventBusStore.saveConfig({ retentionCount: 1000, retentionMs: 3600000, persistToDisk: true });
    const loaded = eventBusStore.loadConfig();
    expect(loaded.retentionCount).toBe(1000);
    expect(loaded.retentionMs).toBe(3600000);
  });
});
