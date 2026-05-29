// Auto-judge for ESCALATED deliberations.
//
// When a deliberation cannot reach consensus (cap_exhausted, quorum_lost,
// dropout_was_dissenter, all_probes_failed), it lands on ESCALATED and
// traditionally waits for `zana_deliberation_override` from a human. In
// autopilot/scheduled contexts no human is watching, so the deliberation
// stalls indefinitely.
//
// The auto-judge is a single agent that reads the full transcript (question,
// each voter's rationale, dissent verbatim, escalation reason, per-round
// tally) and emits a verdict. Its output lands on the deliberation via the
// existing `recordOverride` API — the only difference from a human override
// is the `humanId` (`"judge:<profileId>"`), which `recordOverride` uses to
// stamp `verdictSource: "judge"`.
//
// This module is invoked by deliberate.ts AFTER the orchestration loop
// reaches a terminal-escalation state. It does not mutate the state machine
// directly — it calls recordOverride, which is already a legal
// ESCALATED → SETTLED transition.
//
// Design intent: keep the decision engine (decide / applyDecision) pure and
// human-overridable. The judge is an orchestration-layer follow-up, not a
// new path through the state machine.

// Type-only import — we read the source TS directly because @zana/work
// exposes `deliberation` via its dist CJS index without re-exporting the
// type. No runtime cost: TS strips type-only imports.
import type { Deliberation } from "../../../work/src/deliberation/types";

function _work(): any { return require("@zana/work"); }
function _core(): any { return require("@zana/core"); }
function _delib(): any { return _work().deliberation; }

export interface AdjudicateDeps {
  // Spawn primitive — overridable for tests. Defaults to
  // core.agents.spawner.spawnOneShot.
  spawnOneShot?: (
    profile: any,
    prompt: string,
    options?: { cwd?: string; timeout?: number },
  ) => Promise<{ output: string; exitCode: number }>;
  // Profile resolver — defaults to core.agents.profileStore.getProfile.
  getProfile?: (id: string) => any;
  // Content-addressed reader for voter rationales and dissent — defaults to
  // work.runs.artifacts.readContentAddressed.
  readContentAddressed?: (hash: string) => Buffer | null;
}

export interface JudgeVerdict {
  verdict: "approve" | "reject" | "rework";
  rationale: string;
  humanId: string;            // always "judge:<profileId>"
}

/**
 * Build the prompt the judge sees. Public for tests.
 */
export function buildJudgePrompt(
  d: Deliberation,
  voterRationales: Array<{ profileId: string; round: number; bit: string; text: string }>,
  dissents: Array<{ profileId: string; round: number; text: string }>,
): string {
  const lines: string[] = [];
  lines.push("# Council deliberation — escalated for adjudication");
  lines.push("");
  lines.push(`Escalation reason: ${d.escalationReason ?? "(unspecified)"}`);
  lines.push(`Risk tag: ${d.riskTag ?? "low"}`);
  lines.push(`Rounds run: ${d.currentRound} of ${d.rounds} (cap)`);
  lines.push(`Quorum: ${d.quorum}, voters: ${d.voters.length}`);
  lines.push("");
  lines.push("## Question");
  lines.push(d.question);
  lines.push("");
  lines.push("## Voter rationales");
  if (voterRationales.length === 0) {
    lines.push("(none recorded)");
  } else {
    for (const r of voterRationales) {
      lines.push(`### ${r.profileId} (round ${r.round}, voted ${r.bit})`);
      lines.push(r.text || "(empty rationale)");
      lines.push("");
    }
  }
  lines.push("## Dissent (verbatim)");
  if (dissents.length === 0) {
    lines.push("(no dissent recorded)");
  } else {
    for (const ds of dissents) {
      lines.push(`### ${ds.profileId} (round ${ds.round})`);
      lines.push(ds.text || "(empty)");
      lines.push("");
    }
  }
  lines.push("");
  lines.push("## Your task");
  lines.push(
    "Pick the verdict most consistent with the goal in the question above. " +
    "Output line 1 must be exactly 'VERDICT: approve', 'VERDICT: reject', or 'VERDICT: rework'. " +
    "Follow with a one-paragraph rationale citing the voter profile ids you found most persuasive.",
  );
  return lines.join("\n");
}

/**
 * Parse `VERDICT: <decision>` from the judge's output. Returns null on
 * malformed output so the caller can leave the deliberation ESCALATED for a
 * human to take a second pass.
 */
export function parseJudgeOutput(
  output: string,
): { verdict: "approve" | "reject" | "rework"; rationale: string } | null {
  if (typeof output !== "string" || output.trim() === "") return null;
  const m = output.match(/VERDICT:\s*(approve|reject|rework)\b/i);
  if (!m) return null;
  const verdict = m[1].toLowerCase() as "approve" | "reject" | "rework";
  // Rationale = everything after the VERDICT line, trimmed. If the verdict
  // line is the only content, surface the whole output as rationale so the
  // audit trail isn't empty.
  const after = output.slice((m.index ?? 0) + m[0].length).trim();
  const rationale = after.length > 0 ? after : output.trim();
  return { verdict, rationale };
}

/**
 * Core: spawn a judge agent on an ESCALATED deliberation, record its verdict
 * via recordOverride, return the verdict object.
 *
 * Throws if:
 *   - the deliberation is not in ESCALATED state
 *   - the judge profile cannot be resolved
 *   - spawnOneShot exits non-zero
 *   - the output cannot be parsed
 *
 * On any throw, the deliberation is left untouched (still ESCALATED) so a
 * human can call zana_deliberation_override.
 */
export async function adjudicateEscalation(
  deliberationId: string,
  deps: AdjudicateDeps = {},
): Promise<JudgeVerdict> {
  const work = _work();
  const core = _core();
  const delib = _delib();

  const d: Deliberation | null = delib.loadDeliberation(deliberationId);
  if (!d) throw new Error(`adjudicateEscalation: deliberation not found: ${deliberationId}`);
  if (d.state !== "ESCALATED") {
    throw new Error(
      `adjudicateEscalation: deliberation ${deliberationId} is not ESCALATED (state=${d.state})`,
    );
  }

  const cfg = delib.getRuntimeConfig();
  const profileId = cfg.judgeProfileId || "judge";
  const timeout = typeof cfg.judgeTimeoutMs === "number" && cfg.judgeTimeoutMs > 0
    ? cfg.judgeTimeoutMs
    : 10 * 60 * 1000;

  const getProfile = deps.getProfile ?? core.agents.profileStore.getProfile;
  const profile = getProfile(profileId);
  if (!profile) {
    throw new Error(`adjudicateEscalation: judge profile '${profileId}' not found`);
  }

  const readCAS = deps.readContentAddressed
    ?? ((hash: string) => work.runs.artifacts.readContentAddressed(hash));

  // Resolve voter rationales by hash. Skip silently on unreadable hashes —
  // the audit trail still has the hash for forensic recovery; we just don't
  // re-show that voter's text to the judge.
  const voterRationales: Array<{ profileId: string; round: number; bit: string; text: string }> = [];
  for (const v of d.votes) {
    const buf = readCAS(v.rationaleHash);
    voterRationales.push({
      profileId: v.profileId,
      round: v.round,
      bit: v.bit,
      text: buf ? buf.toString("utf8") : "",
    });
  }
  const dissents: Array<{ profileId: string; round: number; text: string }> = [];
  for (const ds of d.dissent) {
    const buf = readCAS(ds.rationaleHash);
    dissents.push({
      profileId: ds.profileId,
      round: ds.round,
      text: buf ? buf.toString("utf8") : "",
    });
  }

  const prompt = buildJudgePrompt(d, voterRationales, dissents);

  const spawnOneShot = deps.spawnOneShot ?? core.agents.spawner.spawnOneShot;
  const result = await spawnOneShot(profile, prompt, { timeout });
  if (!result || result.exitCode !== 0) {
    throw new Error(
      `adjudicateEscalation: judge spawn failed (exitCode=${result?.exitCode}): ${
        (result?.output || "").slice(0, 300)
      }`,
    );
  }

  const parsed = parseJudgeOutput(result.output || "");
  if (!parsed) {
    throw new Error(
      `adjudicateEscalation: could not parse VERDICT from judge output: ${
        (result.output || "").slice(0, 300)
      }`,
    );
  }

  const humanId = `judge:${profileId}`;
  // Land the verdict via recordOverride. We go through the work-package API
  // directly rather than the MCP handler because we already have the
  // deliberation loaded and validated; deliberationOverrideHandler does its
  // own load + version assertion which would race.
  const stored = work.runs.artifacts.storeContentAddressed(parsed.rationale);
  delib.recordOverride(deliberationId, {
    humanId,
    decision: parsed.verdict,
    reasonHash: stored.hash,
    ts: new Date().toISOString(),
  });

  return { verdict: parsed.verdict, rationale: parsed.rationale, humanId };
}

/**
 * Decision gate: should the auto-judge run on this deliberation given the
 * configured strategy? Pure, exported for tests and for use by the deliberate
 * orchestrator.
 *
 * High-risk deliberations always escalate to a human regardless of strategy
 * (per design — confirmed with operator). The "judge" and "hybrid" strategies
 * are functionally equivalent today; "hybrid" exists as a forward-compatible
 * intent marker for future per-tag policies.
 */
export function shouldJudge(
  d: Pick<Deliberation, "state" | "riskTag">,
  strategy: string | undefined,
): boolean {
  if (d.state !== "ESCALATED") return false;
  if (d.riskTag === "high") return false;
  if (strategy === "judge" || strategy === "hybrid") return true;
  return false;
}
