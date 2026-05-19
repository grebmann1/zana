/**
 * Schedule YAML/JSON schema contract.
 *
 * This file is the single source of truth for which fields the scheduler
 * understands. Anything not listed in TOP_LEVEL_FIELDS is ignored (and
 * validateSchedule warns on it). Anything in DAEMON_MANAGED_FIELDS is
 * overwritten on each run — users editing the YAML should not set them.
 */

export const TOP_LEVEL_FIELDS = [
  "id",
  "name",
  "description",
  "enabled",
  "schedule",
  "action",
  "history",
  "ownerId",
  "ownerName",
  "createdAt",
  "updatedAt",
  "status",
  // legacy flat fields the parser still accepts but discourages:
  "cron",
  "every",
  "intervalMs",
  "lastRunAt",
  "lastRunResult",
  "nextRunAt",
  "runCount",
] as const;

export const SCHEDULE_BLOCK_FIELDS = ["cron", "every", "intervalMs"] as const;

export const ACTION_TYPES = [
  "spawn-agent",
  "prompt", // alias of spawn-agent
  "team",
  "command",
  "workflow",
  "mcp_tool",
] as const;

export const HISTORY_DEFAULTS = {
  enabled: true,
  retain: 10,
};
export const HISTORY_RETAIN_MAX = 1000;

export const DAEMON_MANAGED_FIELDS = [
  "createdAt",
  "updatedAt",
  "status",
  "lastRunAt",
  "lastRunResult",
  "nextRunAt",
  "runCount",
];

export interface ValidationIssue {
  level: "error" | "warning";
  field: string;
  message: string;
}

export function validateSchedule(raw: any): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!raw || typeof raw !== "object") {
    issues.push({ level: "error", field: "(root)", message: "schedule must be an object" });
    return issues;
  }

  if (!raw.id || typeof raw.id !== "string") {
    issues.push({ level: "error", field: "id", message: "id is required and must be a string" });
  }
  if (!raw.name || typeof raw.name !== "string") {
    issues.push({ level: "error", field: "name", message: "name is required and must be a string" });
  }

  // Trigger: at least one of cron / every / intervalMs (in nested or flat form).
  // Disabled schedules don't need a trigger — they're manual-only.
  const block = raw.schedule || {};
  const hasTrigger = !!(
    block.cron ||
    block.every ||
    block.intervalMs ||
    raw.cron ||
    raw.every ||
    raw.intervalMs
  );
  if (!hasTrigger && raw.enabled !== false) {
    issues.push({
      level: "error",
      field: "schedule",
      message: "enabled schedule must have at least one of cron / every / intervalMs",
    });
  }

  // Unknown top-level fields → warning
  for (const k of Object.keys(raw)) {
    if (k.startsWith("_")) continue; // internal markers
    if (!(TOP_LEVEL_FIELDS as readonly string[]).includes(k)) {
      issues.push({
        level: "warning",
        field: k,
        message: `unknown field "${k}" — will be ignored. Allowed: ${TOP_LEVEL_FIELDS.join(", ")}`,
      });
    }
  }

  // Unknown schedule.* fields → warning
  if (raw.schedule && typeof raw.schedule === "object") {
    for (const k of Object.keys(raw.schedule)) {
      if (!(SCHEDULE_BLOCK_FIELDS as readonly string[]).includes(k)) {
        issues.push({
          level: "warning",
          field: `schedule.${k}`,
          message: `unknown schedule field "${k}". Allowed: ${SCHEDULE_BLOCK_FIELDS.join(", ")}`,
        });
      }
    }
  }

  // Action validation
  if (!raw.action || typeof raw.action !== "object") {
    issues.push({ level: "error", field: "action", message: "action is required" });
  } else {
    const t = raw.action.type;
    if (!t || !(ACTION_TYPES as readonly string[]).includes(t)) {
      issues.push({
        level: "error",
        field: "action.type",
        message: `action.type must be one of: ${ACTION_TYPES.join(", ")}`,
      });
    }
  }

  // history.* validation
  if (raw.history !== undefined) {
    if (typeof raw.history !== "object" || raw.history === null) {
      issues.push({ level: "error", field: "history", message: "history must be an object" });
    } else {
      if (raw.history.enabled !== undefined && typeof raw.history.enabled !== "boolean") {
        issues.push({ level: "error", field: "history.enabled", message: "history.enabled must be boolean" });
      }
      if (raw.history.retain !== undefined) {
        const r = raw.history.retain;
        if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r > HISTORY_RETAIN_MAX) {
          issues.push({
            level: "error",
            field: "history.retain",
            message: `history.retain must be an integer between 0 and ${HISTORY_RETAIN_MAX}`,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Resolve the effective history config for a schedule, applying defaults.
 * Returns { enabled, retain } where retain is clamped to [0, HISTORY_RETAIN_MAX].
 */
export function resolveHistoryConfig(schedule: any): { enabled: boolean; retain: number } {
  const h = (schedule && typeof schedule === "object" && schedule.history) || {};
  const enabled = typeof h.enabled === "boolean" ? h.enabled : HISTORY_DEFAULTS.enabled;
  let retain = typeof h.retain === "number" && Number.isFinite(h.retain) ? Math.floor(h.retain) : HISTORY_DEFAULTS.retain;
  if (retain < 0) retain = 0;
  if (retain > HISTORY_RETAIN_MAX) retain = HISTORY_RETAIN_MAX;
  return { enabled, retain };
}
