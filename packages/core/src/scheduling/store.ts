import * as fs from "node:fs";
import * as path from "node:path";
import * as configMod from "../config";

const MAX_HISTORY = 10;

function getSchedulerDir(): string {
  return (configMod as any).SCHEDULER_DIR;
}

export function ensureDir() {
  fs.mkdirSync(getSchedulerDir(), { recursive: true });
}

export function listSchedules() {
  ensureDir();
  const files = fs.readdirSync(getSchedulerDir()).filter((f) => f.endsWith(".json") && !f.endsWith(".history.json"));
  const schedules = [];

  for (const f of files) {
    try {
      schedules.push(JSON.parse(fs.readFileSync(path.join(getSchedulerDir(), f), "utf8")));
    } catch {
      // skip malformed
    }
  }

  return schedules.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function getSchedule(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(getSchedulerDir(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function saveSchedule(schedule) {
  ensureDir();
  fs.writeFileSync(
    path.join(getSchedulerDir(), `${schedule.id}.json`),
    JSON.stringify(schedule, null, 2) + "\n",
    "utf8"
  );
  return schedule;
}

export function deleteSchedule(id) {
  try {
    fs.unlinkSync(path.join(getSchedulerDir(), `${id}.json`));
  } catch {
    // ok
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

