import * as fs from "node:fs";
import * as path from "node:path";
import * as configMod from "./config";

const EVENTS_DIR = (configMod as any).EVENTS_DIR;
const EVENTS_FILE = path.join(EVENTS_DIR, "bus-events.ndjson");
const CONFIG_FILE = path.join(EVENTS_DIR, "bus-config.json");

const DEFAULT_CONFIG = {
  retentionCount: 5000,
  retentionMs: 86400000,
  persistToDisk: true,
};

export function ensureDir() {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
}

export function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function appendEvent(event) {
  ensureDir();
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(EVENTS_FILE, line, "utf8");
}

export function queryEvents(filter = {}, limit = 100) {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    let events = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }

    if (filter.types && filter.types.length > 0) {
      events = events.filter((e) => filter.types.includes(e.type));
    }
    if (filter.source) {
      events = events.filter((e) => e.source === filter.source);
    }
    if (filter.since) {
      events = events.filter((e) => e.timestamp >= filter.since);
    }
    if (filter.workspace) {
      events = events.filter((e) => e.workspace === filter.workspace);
    }
    if (filter.tags && filter.tags.length > 0) {
      events = events.filter((e) =>
        e.tags && filter.tags.some((t) => e.tags.includes(t))
      );
    }

    return events.slice(-limit);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[event-bus-store] query error:", err.message);
    }
    return [];
  }
}

export function compact(config) {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const now = Date.now();
    const cutoff = now - (config.retentionMs || DEFAULT_CONFIG.retentionMs);
    const maxCount = config.retentionCount || DEFAULT_CONFIG.retentionCount;

    let events = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.timestamp >= cutoff) {
          events.push(evt);
        }
      } catch {
        // skip
      }
    }

    if (events.length > maxCount) {
      events = events.slice(-maxCount);
    }

    ensureDir();
    const output = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
    fs.writeFileSync(EVENTS_FILE, output, "utf8");
    return events.length;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[event-bus-store] compact error:", err.message);
    }
    return 0;
  }
}

