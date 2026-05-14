import * as fs from "node:fs";
import * as path from "node:path";
import { RUNS_DIR } from "./config";

function ensureDir() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

export function listRuns({ limit = 50, offset = 0, status } = {}) {
  ensureDir();
  try {
    const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
    let runs = files.map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"));
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (status) {
      runs = runs.filter((r) => r.status === status);
    }

    runs.sort((a, b) => b.startedAt - a.startedAt);
    return runs.slice(offset, offset + limit);
  } catch {
    return [];
  }
}

export function getRun(id) {
  if (!id) return null;
  ensureDir();
  const filePath = path.join(RUNS_DIR, `${id}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function saveRun(run) {
  ensureDir();
  const filePath = path.join(RUNS_DIR, `${run.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(run, null, 2) + "\n", "utf8");
  return run;
}

export function deleteRun(id) {
  if (!id) return false;
  const filePath = path.join(RUNS_DIR, `${id}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

