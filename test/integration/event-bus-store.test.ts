import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const EVENTS_DIR = path.join(os.homedir(), ".zana", "events");
const EVENTS_FILE = path.join(EVENTS_DIR, "bus-events.ndjson");
const CONFIG_FILE = path.join(EVENTS_DIR, "bus-config.json");

import * as eventBusStore from "@zana/core/src/events/store.ts";

describe("event-bus-store", () => {
  let originalContent = null;

  beforeEach(() => {
    try {
      originalContent = fs.readFileSync(EVENTS_FILE, "utf8");
    } catch {
      originalContent = null;
    }
  });

  afterEach(() => {
    if (originalContent !== null) {
      fs.writeFileSync(EVENTS_FILE, originalContent, "utf8");
    } else {
      try { fs.unlinkSync(EVENTS_FILE); } catch {}
    }
    try { fs.unlinkSync(CONFIG_FILE); } catch {}
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
