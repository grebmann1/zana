import * as YAML from "yaml";

/**
 * YAML serialization for Zana scheduled tasks.
 *
 * Format:
 *   id: ...
 *   name: ...
 *   description: ...
 *   enabled: true
 *   schedule:
 *     cron: "0 2 * * *"   # OR every: 5m
 *   action:
 *     type: spawn-agent   # OR workflow OR command
 *     ...
 *   status:               # managed by daemon
 *     lastRunAt: ...
 *     ...
 */

const HEADER = [
  "Zana scheduled task — edit this file directly to change the schedule.",
  "Status fields (lastRunAt, nextRunAt, lastRunResult, runCount) are managed",
  "by the daemon and may be overwritten on each run.",
].join("\n");

/**
 * Convert a plain schedule object into a YAML string with header comment.
 * Preserves a stable field ordering so diffs are readable.
 */
export function serializeYaml(schedule: any): string {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("serializeYaml: schedule must be an object");
  }

  // Build an ordered, normalized representation.
  const ordered: any = {};
  if (schedule.id != null) ordered.id = schedule.id;
  if (schedule.name != null) ordered.name = schedule.name;
  if (schedule.description != null) ordered.description = schedule.description;
  if (schedule.enabled != null) ordered.enabled = schedule.enabled;

  // schedule block — normalize cron / every / intervalMs
  const sched: any = {};
  if (schedule.schedule && typeof schedule.schedule === "object") {
    if (schedule.schedule.cron) sched.cron = schedule.schedule.cron;
    if (schedule.schedule.every) sched.every = schedule.schedule.every;
    if (schedule.schedule.intervalMs != null) sched.intervalMs = schedule.schedule.intervalMs;
  }
  // legacy flat fields
  if (!sched.cron && schedule.cron) sched.cron = schedule.cron;
  if (!sched.intervalMs && schedule.intervalMs != null) sched.intervalMs = schedule.intervalMs;
  if (Object.keys(sched).length > 0) ordered.schedule = sched;

  // action — pass through
  if (schedule.action) ordered.action = schedule.action;

  // history — pass through if user-configured
  if (schedule.history && typeof schedule.history === "object") {
    ordered.history = schedule.history;
  }

  // owner / metadata fields
  if (schedule.ownerId != null) ordered.ownerId = schedule.ownerId;
  if (schedule.ownerName != null) ordered.ownerName = schedule.ownerName;
  if (schedule.createdAt != null) ordered.createdAt = schedule.createdAt;
  if (schedule.updatedAt != null) ordered.updatedAt = schedule.updatedAt;

  // status — daemon-managed
  const status: any = {};
  if (schedule.status && typeof schedule.status === "object") {
    Object.assign(status, schedule.status);
  }
  // pull legacy flat status fields up if present
  if (schedule.lastRunAt != null && status.lastRunAt == null) status.lastRunAt = schedule.lastRunAt;
  if (schedule.lastRunResult != null && status.lastRunResult == null) {
    status.lastRunResult = schedule.lastRunResult;
  }
  if (schedule.nextRunAt != null && status.nextRunAt == null) status.nextRunAt = schedule.nextRunAt;
  if (schedule.runCount != null && status.runCount == null) status.runCount = schedule.runCount;
  if (Object.keys(status).length > 0) ordered.status = status;

  // Use the Document API so we can attach a header comment.
  const doc = new YAML.Document(ordered);
  doc.commentBefore = HEADER.split("\n").map((l) => " " + l).join("\n");
  return doc.toString();
}

/**
 * Parse YAML content into a schedule object. Returns null on parse error
 * rather than throwing — callers (the store) should treat malformed files
 * as missing.
 */
export function parseYaml(content: string): any | null {
  if (typeof content !== "string") return null;
  try {
    const parsed = YAML.parse(content);
    if (parsed == null || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

const EVERY_RE = /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/i;

/**
 * Convert "5m" / "1h" / "30s" / "2d" / "500ms" shorthand to milliseconds.
 * Throws on bad input — caller decides how to surface.
 */
export function everShorthandToMs(s: string): number {
  if (typeof s !== "string") throw new Error(`everShorthandToMs: not a string: ${s}`);
  const m = s.match(EVERY_RE);
  if (!m) throw new Error(`everShorthandToMs: invalid shorthand: ${s}`);
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`everShorthandToMs: non-positive value: ${s}`);
  const unit = m[2].toLowerCase();
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      throw new Error(`everShorthandToMs: unknown unit: ${unit}`);
  }
}

/**
 * Inverse of everShorthandToMs — pick the largest unit that the
 * milliseconds value divides cleanly into. Falls back to "<n>ms".
 */
export function msToEvery(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    throw new Error(`msToEvery: invalid ms value: ${ms}`);
  }
  const units: Array<[string, number]> = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ];
  for (const [unit, size] of units) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}
