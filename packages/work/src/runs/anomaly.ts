/**
 * Post-run anomaly detection for headless agent runs.
 *
 * A pure function over a persisted agent-run record (the shape written by
 * `persistAgentRun` in packages/core/src/agents/lifecycle.ts). It flags runs
 * that completed but look unhealthy, so an orchestrator/operator can notice a
 * "booted but burned budget / exited nonzero" run without log-grepping.
 *
 * Ported from claude-unleashed's detectAnomalies (a pure events→anomalies
 * function) — see reviews/claude-unleashed-incorporation.md §Phase 3. zana's
 * headless agent record exposes costUsd / durationMs / token counts / exitCode,
 * so we classify on those. `repeated-tool-call` (needs the tool_use stream) is
 * deferred — see the report.
 */

export type AnomalySeverity = "info" | "warn" | "critical";

export interface Anomaly {
  kind: "near-limit" | "non-zero-exit";
  detail: string;
  severity: AnomalySeverity;
}

export interface AnomalyResult {
  anomalies: Anomaly[];
  severity: AnomalySeverity; // max severity across anomalies; "info" when none
}

export interface AnomalyLimits {
  maxCostUsd: number;
  maxDurationMs: number;
  maxTokens: number;
  /** Fraction of a limit above which a run is "near" it. */
  nearThreshold: number;
}

// Tuned for zana's short-lived headless agents (default ~10-min cap), NOT
// claude-unleashed's multi-hour sessions. Override per-call if needed.
export const DEFAULT_ANOMALY_LIMITS: AnomalyLimits = {
  maxCostUsd: 5,
  maxDurationMs: 10 * 60 * 1000, // 10 min — matches AGENT_TIMEOUT_MS default
  maxTokens: 1_000_000,
  nearThreshold: 0.8,
};

const RANK: Record<AnomalySeverity, number> = { info: 0, warn: 1, critical: 2 };

function maxSeverity(anomalies: Anomaly[]): AnomalySeverity {
  let s: AnomalySeverity = "info";
  for (const a of anomalies) if (RANK[a.severity] > RANK[s]) s = a.severity;
  return s;
}

/**
 * Inspect a terminated agent-run record. `record` is the object persisted to
 * runs/<id>.json — fields are best-effort (older records may lack some).
 */
export function detectAnomalies(
  record: any,
  limits: AnomalyLimits = DEFAULT_ANOMALY_LIMITS,
): AnomalyResult {
  const anomalies: Anomaly[] = [];
  if (!record || typeof record !== "object") {
    return { anomalies, severity: "info" };
  }

  // 1. Non-zero exit — the agent process exited with a failure code.
  const exit = record.exitCode;
  if (typeof exit === "number" && exit !== 0) {
    anomalies.push({
      kind: "non-zero-exit",
      detail: `agent exited with code ${exit}`,
      severity: "warn",
    });
  }

  // 2. Near-limit — cost / wall-clock / tokens approached a budget ceiling.
  const near = limits.nearThreshold;
  const cost = typeof record.costUsd === "number" ? record.costUsd : null;
  if (cost != null && cost >= limits.maxCostUsd * near) {
    anomalies.push({
      kind: "near-limit",
      detail: `cost $${cost.toFixed(2)} ≥ ${Math.round(near * 100)}% of $${limits.maxCostUsd} budget`,
      severity: cost >= limits.maxCostUsd ? "critical" : "warn",
    });
  }

  const dur = typeof record.durationMs === "number" ? record.durationMs : null;
  if (dur != null && dur >= limits.maxDurationMs * near) {
    anomalies.push({
      kind: "near-limit",
      detail: `duration ${Math.round(dur / 1000)}s ≥ ${Math.round(near * 100)}% of ${Math.round(limits.maxDurationMs / 1000)}s cap`,
      severity: dur >= limits.maxDurationMs ? "critical" : "warn",
    });
  }

  const tokens =
    (typeof record.tokensIn === "number" ? record.tokensIn : 0) +
    (typeof record.tokensOut === "number" ? record.tokensOut : 0);
  if (tokens > 0 && tokens >= limits.maxTokens * near) {
    anomalies.push({
      kind: "near-limit",
      detail: `${tokens} tokens ≥ ${Math.round(near * 100)}% of ${limits.maxTokens} budget`,
      severity: tokens >= limits.maxTokens ? "critical" : "warn",
    });
  }

  return { anomalies, severity: maxSeverity(anomalies) };
}
