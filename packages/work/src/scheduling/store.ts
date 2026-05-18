import * as fs from "node:fs";
import * as path from "node:path";
import { serializeYaml, parseYaml } from "./yaml-format";

const MAX_HISTORY = 10;

function getSchedulerDir(): string {
  return require("@zana/core").config.SCHEDULER_DIR;
}

export function ensureDir() {
  fs.mkdirSync(getSchedulerDir(), { recursive: true });
}

function jsonPath(id: string): string {
  return path.join(getSchedulerDir(), `${id}.json`);
}

function yamlPath(id: string): string {
  return path.join(getSchedulerDir(), `${id}.yml`);
}

function readFileMaybe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Walk the scheduler dir, returning every parseable schedule. Both
 * `<id>.yml` and `<id>.json` files are picked up. If both exist for the
 * same id, the YAML wins.
 */
export function listSchedules() {
  ensureDir();
  let files: string[];
  try {
    files = fs.readdirSync(getSchedulerDir());
  } catch {
    return [];
  }

  const byId = new Map<string, any>();
  const yamlIds = new Set<string>();

  // First pass: YAML files (preferred).
  for (const f of files) {
    if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
    if (f.endsWith(".yml.example") || f.endsWith(".yaml.example")) continue;
    const content = readFileMaybe(path.join(getSchedulerDir(), f));
    if (content == null) continue;
    const parsed = parseYaml(content);
    if (!parsed || !parsed.id) continue;
    parsed._format = "yaml";
    byId.set(parsed.id, parsed);
    yamlIds.add(parsed.id);
  }

  // Second pass: JSON files, skipping ones we already saw via YAML.
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    if (f.endsWith(".history.json")) continue;
    const content = readFileMaybe(path.join(getSchedulerDir(), f));
    if (content == null) continue;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    if (!parsed || !parsed.id) continue;
    if (yamlIds.has(parsed.id)) continue;
    parsed._format = "json";
    byId.set(parsed.id, parsed);
  }

  const schedules = Array.from(byId.values());
  return schedules.sort((a, b) => {
    const aT = new Date(a.updatedAt || 0).getTime();
    const bT = new Date(b.updatedAt || 0).getTime();
    return bT - aT;
  });
}

export function getSchedule(id) {
  // Prefer YAML if both formats exist.
  const yamlContent = readFileMaybe(yamlPath(id));
  if (yamlContent != null) {
    const parsed = parseYaml(yamlContent);
    if (parsed && parsed.id) {
      parsed._format = "yaml";
      return parsed;
    }
  }
  const jsonContent = readFileMaybe(jsonPath(id));
  if (jsonContent != null) {
    try {
      const parsed = JSON.parse(jsonContent);
      if (parsed) parsed._format = "json";
      return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Write the schedule as JSON (legacy default). Preferred path for new
 * schedules is saveScheduleYaml below.
 */
export function saveSchedule(schedule) {
  ensureDir();
  // Strip in-memory _format marker before persisting.
  const { _format, ...rest } = schedule || {};
  fs.writeFileSync(
    jsonPath(schedule.id),
    JSON.stringify(rest, null, 2) + "\n",
    "utf8"
  );
  return schedule;
}

/**
 * Write the schedule as YAML. The default format for v2.
 */
export function saveScheduleYaml(schedule) {
  ensureDir();
  const { _format, ...rest } = schedule || {};
  const yaml = serializeYaml(rest);
  fs.writeFileSync(yamlPath(schedule.id), yaml, "utf8");
  return schedule;
}

/**
 * Save in whichever format the schedule was originally loaded from.
 * Falls back to YAML for new schedules.
 */
export function saveScheduleSameFormat(schedule) {
  if (schedule && schedule._format === "json") return saveSchedule(schedule);
  return saveScheduleYaml(schedule);
}

export function deleteSchedule(id) {
  for (const p of [jsonPath(id), yamlPath(id), path.join(getSchedulerDir(), `${id}.yaml`)]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // ok
    }
  }
  try {
    fs.unlinkSync(path.join(getSchedulerDir(), `${id}.history.json`));
  } catch {
    // ok
  }
  return true;
}

export function getRunHistory(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(getSchedulerDir(), `${id}.history.json`), "utf8"));
  } catch {
    return [];
  }
}

export function appendRunResult(id, result) {
  ensureDir();
  let history = getRunHistory(id);
  history.push(result);
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }
  fs.writeFileSync(
    path.join(getSchedulerDir(), `${id}.history.json`),
    JSON.stringify(history, null, 2) + "\n",
    "utf8"
  );
  return history;
}
