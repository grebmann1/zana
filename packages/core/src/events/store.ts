import * as fs from "node:fs";
import * as path from "node:path";
import * as configMod from "../config";

// FU-T2e — DO NOT snapshot EVENTS_DIR at module load time.
//
// Prior versions did `const EVENTS_DIR = configMod.EVENTS_DIR` at the top of
// this module. Because this file is required from many entry points, the
// snapshot frequently froze BEFORE workspaceContext.init() ran, which in turn
// pinned every appendEvent() to the global ~/.zana/events/ directory — across
// every workspace on the same host. Hashes alone are stored, but the voter
// modelIds, profileIds, tally distributions and deliberation cadence in those
// records are sufficient to correlate activity between tenants.
//
// We instead lazy-resolve EVENTS_DIR on every call via the @zana-ai/core config
// module's workspace-aware getter (see packages/core/src/config.ts where
// EVENTS_DIR is exposed as a `get EVENTS_DIR()` accessor on module.exports).
// Reading `configMod.EVENTS_DIR` here triggers that getter every time, so
// switching the workspace mid-process is reflected on the very next call.
// This matches the pattern already used by
// packages/work/src/runs/artifact-store.ts:getArtifactsDir(). The cost is a
// property read per write — cheap.
function getEventsDir(): string {
  return (configMod as any).EVENTS_DIR;
}

function getEventsFile(): string {
  return path.join(getEventsDir(), "bus-events.ndjson");
}

function getConfigFile(): string {
  return path.join(getEventsDir(), "bus-config.json");
}

const DEFAULT_CONFIG = {
  retentionCount: 5000,
  retentionMs: 86400000,
  persistToDisk: true,
};

export function ensureDir() {
  fs.mkdirSync(getEventsDir(), { recursive: true });
}

export function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(getConfigFile(), "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config) {
  ensureDir();
  fs.writeFileSync(getConfigFile(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function appendEvent(event) {
  ensureDir();
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(getEventsFile(), line, "utf8");
}

export function queryEvents(filter = {}, limit = 100) {
  try {
    const raw = fs.readFileSync(getEventsFile(), "utf8");
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
    const eventsFile = getEventsFile();
    const raw = fs.readFileSync(eventsFile, "utf8");
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
    fs.writeFileSync(eventsFile, output, "utf8");
    return events.length;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[event-bus-store] compact error:", err.message);
    }
    return 0;
  }
}

