/**
 * Pluggable trigger backends for the scheduler.
 *
 * pickBackend() inspects a schedule and returns the right backend module
 * along with the start arg the caller needs to pass.
 *
 * Order of preference:
 *   1. cron field present  → cron backend
 *   2. intervalMs / every  → interval backend
 *   3. neither             → null (caller should treat as invalid)
 */
import * as intervalBackend from "./interval";
import * as cronBackend from "./cron";
import { everShorthandToMs } from "../yaml-format";

export interface PickedBackend {
  kind: "cron" | "interval";
  start: (scheduleId: string, arg: any, fireFn: () => void) => any;
  stop: (handle: any) => void;
  arg: any;
}

function readScheduleBlock(schedule: any) {
  const block = schedule?.schedule || {};
  const cron = block.cron || schedule?.cron || null;
  let intervalMs: number | null = block.intervalMs ?? schedule?.intervalMs ?? null;
  const every = block.every || schedule?.every || null;
  if (intervalMs == null && typeof every === "string") {
    try {
      intervalMs = everShorthandToMs(every);
    } catch {
      intervalMs = null;
    }
  }
  return { cron, intervalMs };
}

export function pickBackend(schedule: any): PickedBackend | null {
  const { cron, intervalMs } = readScheduleBlock(schedule);
  if (cron) {
    if (!cronBackend.validate(cron)) return null;
    return {
      kind: "cron",
      start: cronBackend.start,
      stop: cronBackend.stop,
      arg: cron,
    };
  }
  if (intervalMs && intervalMs > 0) {
    return {
      kind: "interval",
      start: intervalBackend.start,
      stop: intervalBackend.stop,
      arg: intervalMs,
    };
  }
  return null;
}

/**
 * Compute the next fire time for a schedule (cron only — interval is just
 * "now + intervalMs", caller can compute that directly). Returns ISO string.
 */
export function computeNextRunAt(schedule: any, from: Date = new Date()): string | null {
  const { cron, intervalMs } = readScheduleBlock(schedule);
  if (cron) return cronBackend.nextFireAt(cron, from);
  if (intervalMs && intervalMs > 0) return new Date(from.getTime() + intervalMs).toISOString();
  return null;
}

export { intervalBackend, cronBackend };
