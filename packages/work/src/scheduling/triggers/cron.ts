/**
 * Cron-based trigger backend — wraps node-cron.
 * Module-level functions, no class.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCron: any = require("node-cron");

export interface CronHandle {
  stop: () => void;
  start?: () => void;
}

export function validate(expr: string): boolean {
  if (typeof expr !== "string" || expr.trim().length === 0) return false;
  try {
    return !!nodeCron.validate(expr);
  } catch {
    return false;
  }
}

export function start(scheduleId: string, expr: string, fireFn: () => void): CronHandle {
  if (!validate(expr)) {
    throw new Error(`cron trigger: invalid expression "${expr}" for schedule ${scheduleId}`);
  }
  const task = nodeCron.schedule(
    expr,
    () => {
      try {
        fireFn();
      } catch (err: any) {
        require("@zana/core").util.logger
          .getLogger("scheduler")
          .error(`cron fire failed for ${scheduleId}`, err);
      }
    },
    { scheduled: true }
  );
  return task as CronHandle;
}

export function stop(handle: CronHandle | null | undefined): void {
  if (handle && typeof handle.stop === "function") {
    try {
      handle.stop();
    } catch {
      // ignore
    }
  }
}

/**
 * Approximate next fire time for a cron expression. node-cron itself
 * does not expose a "next fire" calculator, so we scan minute-by-minute
 * up to 7 days using the same parser semantics. Returns ISO string or null.
 */
export function nextFireAt(expr: string, from: Date = new Date()): string | null {
  if (!validate(expr)) return null;
  try {
    // node-cron parses 5 or 6 fields. We only support 5-field standard cron
    // for next-fire computation. If 6 fields, fall back to minute scan starting
    // at second 0 of the next minute.
    const fields = expr.trim().split(/\s+/);
    if (fields.length < 5 || fields.length > 6) return null;

    // Start from the next whole minute.
    const start = new Date(from.getTime());
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    // 7-day search window — cron expressions that fire less often are rare.
    const horizon = new Date(start.getTime() + 7 * 86_400_000);
    const minuteFields = fields.length === 6 ? fields.slice(1) : fields;
    const [minF, hourF, domF, monF, dowF] = minuteFields;

    const minMatch = compileField(minF, 0, 59);
    const hourMatch = compileField(hourF, 0, 23);
    const domMatch = compileField(domF, 1, 31);
    const monMatch = compileField(monF, 1, 12);
    const dowMatch = compileField(dowF, 0, 7); // 0 and 7 both Sunday

    const cur = new Date(start.getTime());
    while (cur < horizon) {
      const min = cur.getMinutes();
      const hr = cur.getHours();
      const dom = cur.getDate();
      const mon = cur.getMonth() + 1;
      const dow = cur.getDay();
      if (
        minMatch(min) &&
        hourMatch(hr) &&
        monMatch(mon) &&
        domMatch(dom) &&
        (dowMatch(dow) || dowMatch(dow === 0 ? 7 : dow))
      ) {
        return cur.toISOString();
      }
      cur.setTime(cur.getTime() + 60_000);
    }
    return null;
  } catch {
    return null;
  }
}

function compileField(field: string, lo: number, hi: number): (n: number) => boolean {
  if (field === "*") return () => true;
  // Handle comma list of pieces, each piece may be: n, n-m, */k, n-m/k, n/k
  const pieces = field.split(",");
  const tests: Array<(n: number) => boolean> = pieces.map((piece) => {
    let step = 1;
    let range = piece;
    const slash = piece.indexOf("/");
    if (slash !== -1) {
      step = parseInt(piece.slice(slash + 1), 10) || 1;
      range = piece.slice(0, slash);
    }
    let from = lo;
    let to = hi;
    if (range === "*") {
      from = lo;
      to = hi;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map((x) => parseInt(x, 10));
      from = a;
      to = b;
    } else {
      const v = parseInt(range, 10);
      if (Number.isFinite(v)) {
        from = v;
        to = step > 1 ? hi : v;
      }
    }
    return (n: number) => n >= from && n <= to && (n - from) % step === 0;
  });
  return (n) => tests.some((t) => t(n));
}

export const kind = "cron";
