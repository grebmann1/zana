// Deliberation round controller — T8
//
// Decides what happens AFTER a round of votes is in. Pure decision function
// (`decide`) plus an async-mutating wrapper (`applyDecision`) that drives the
// state machine in run.ts.
//
// What this module is NOT in charge of:
//   - Spawning voters (T6 / T9 do that)
//   - Synthesizing reviews (T7 does that)
//   - The MCP-level orchestration loop (T9 does that)
//
// What this module IS in charge of:
//   - Convergence test for the current round
//   - Picking the next state: SETTLE, ADVANCE_ROUND, or ESCALATE
//   - Enforcing the hard cap (default 2 rounds). At cap WITHOUT consensus the
//     deliberation MUST escalate — never auto-pick a verdict on the lead's behalf.
//
// Auto-escalation reasons handled here:
//   - "risk_high"       — high-risk deliberations always go to a human
//   - "quorum_lost"     — current round didn't reach quorum
//   - "cap_exhausted"   — round cap hit with at least one CHANGES vote outstanding

import type {
  Deliberation,
  EscalationReason,
  Verdict,
} from "./types";

import {
  StaleDeliberationError,
  loadDeliberation,
  transition,
} from "./run";
import { getRuntimeConfig } from "./runtime-config";

// ─────────────────────────────────────────────────────────────────────────────
// Pure decision
// ─────────────────────────────────────────────────────────────────────────────

export interface RoundDecisionInput {
  deliberation: Deliberation;
}

export type RoundDecision =
  | { action: "ADVANCE_ROUND"; nextRound: number }
  | {
      action: "SETTLE";
      verdict: Verdict;
      tally: { approve: number; changes: number };
    }
  | {
      action: "ESCALATE";
      reason: EscalationReason;
      tally: { approve: number; changes: number };
    };

function tallyForRound(
  d: Deliberation,
  round: number,
): { approve: number; changes: number } {
  const tally = { approve: 0, changes: 0 };
  for (const v of d.votes) {
    if (v.round !== round) continue;
    if (v.bit === "APPROVE") tally.approve++;
    else if (v.bit === "CHANGES") tally.changes++;
  }
  return tally;
}

export function decide(input: RoundDecisionInput): RoundDecision {
  if (!input || !input.deliberation) {
    throw new Error("decide: deliberation is required");
  }
  const d = input.deliberation;
  const round = d.currentRound;
  const tally = tallyForRound(d, round);

  // 1) Risk gate — high-risk always goes to a human.
  if (d.riskTag === "high") {
    return { action: "ESCALATE", reason: "risk_high", tally };
  }

  // 2) Quorum check — the round must have at least `quorum` votes landed.
  const votesInRound = tally.approve + tally.changes;
  if (votesInRound < d.quorum) {
    return { action: "ESCALATE", reason: "quorum_lost", tally };
  }

  // 3) Convergence — every vote in this round is APPROVE.
  if (tally.changes === 0) {
    const verdict: Verdict =
      d.dissent.length > 0 ? "approve_with_conditions" : "approve";
    return { action: "SETTLE", verdict, tally };
  }

  // 4) Cap check — round cap reached with at least one CHANGES vote → escalate.
  //    Never auto-pick a verdict at the cap.
  if (round >= d.rounds) {
    return { action: "ESCALATE", reason: "cap_exhausted", tally };
  }

  // 5) Otherwise — split vote, cap not reached. Advance to the next round.
  return { action: "ADVANCE_ROUND", nextRound: round + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Async mutating wrapper
// ─────────────────────────────────────────────────────────────────────────────

export interface RoundApplyResult {
  deliberation: Deliberation;
  decision: RoundDecision;
}

export interface ApplyDecisionOptions {
  expectedVersion?: number;
  maxRetries?: number;
}

// Defensive fallback if runtime-config bridge is unreachable.
const DEFAULT_MAX_RETRIES_FALLBACK = 3;

function applyOnce(
  deliberationId: string,
  decision: RoundDecision,
  expectedVersion: number | undefined,
): Deliberation {
  switch (decision.action) {
    case "SETTLE":
      return transition(
        deliberationId,
        "SETTLED",
        {
          verdict: decision.verdict,
          settledAt: new Date().toISOString(),
        },
        expectedVersion === undefined ? undefined : { expectedVersion },
      );
    case "ESCALATE":
      return transition(
        deliberationId,
        "ESCALATED",
        { escalationReason: decision.reason },
        expectedVersion === undefined ? undefined : { expectedVersion },
      );
    case "ADVANCE_ROUND":
      return transition(
        deliberationId,
        "CONVERGING",
        { currentRound: decision.nextRound },
        expectedVersion === undefined ? undefined : { expectedVersion },
      );
    default: {
      const _exhaustive: never = decision;
      void _exhaustive;
      throw new Error(`applyDecision: unknown decision action`);
    }
  }
}

export async function applyDecision(
  deliberationId: string,
  decision: RoundDecision,
  options?: ApplyDecisionOptions,
): Promise<RoundApplyResult> {
  // Read runtime config once at entry — mid-loop changes would shift the bound
  // under retry attempts and produce flaky behavior.
  const configuredMax = (() => {
    const v = getRuntimeConfig().occMaxRetries;
    return typeof v === "number" && v >= 0 ? Math.floor(v) : DEFAULT_MAX_RETRIES_FALLBACK;
  })();
  const maxRetries =
    typeof options?.maxRetries === "number" && options.maxRetries >= 0
      ? Math.floor(options.maxRetries)
      : configuredMax;

  let currentDecision: RoundDecision = decision;
  let expectedVersion: number | undefined = options?.expectedVersion;
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    try {
      const updated = applyOnce(deliberationId, currentDecision, expectedVersion);
      return { deliberation: updated, decision: currentDecision };
    } catch (err) {
      if (!(err instanceof StaleDeliberationError)) {
        throw err;
      }
      lastError = err;

      // State moved on under us. Reload, recompute the decision, retry.
      const fresh = loadDeliberation(deliberationId);
      if (!fresh) {
        throw new Error(
          `applyDecision: deliberation ${deliberationId} disappeared during retry`,
        );
      }

      // Recompute. If state has advanced past CONVERGING/REVIEWING the
      // recomputed decision may be a no-op for the caller; we still try to
      // apply it (transition() will raise on illegal moves).
      currentDecision = decide({ deliberation: fresh });
      expectedVersion = fresh.version;
      attempt++;
    }
  }

  throw new Error(
    `applyDecision: exceeded ${maxRetries} retries for deliberation ${deliberationId}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
