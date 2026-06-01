/**
 * Interval-based trigger backend — wraps setInterval.
 * Module-level functions, no class.
 */

export type IntervalHandle = NodeJS.Timeout;

export function start(scheduleId: string, intervalMs: number, fireFn: () => void): IntervalHandle {
  if (typeof intervalMs !== "number" || intervalMs <= 0 || !Number.isFinite(intervalMs)) {
    throw new Error(`interval trigger: invalid intervalMs=${intervalMs} for schedule ${scheduleId}`);
  }
  const handle = setInterval(() => {
    try {
      fireFn();
    } catch (err: any) {
      // swallow — caller's fireFn should handle its own errors
      require("@zana-ai/core").util.logger
        .getLogger("scheduler")
        .error(`interval fire failed for ${scheduleId}`, err);
    }
  }, intervalMs);
  // Don't keep the event loop alive just for this timer.
  if (typeof (handle as any).unref === "function") (handle as any).unref();
  return handle;
}

export function stop(handle: IntervalHandle): void {
  if (handle) clearInterval(handle);
}

export const kind = "interval";
