// T9 — zana_deliberate MCP tool family.
//
// Surface for multi-voice deliberation. Wires:
//   propose() → assembleCouncil() → [ collectReviews → recordVote × N
//   → synthesize → recordDissent × M → SYNTHESIZING → CONVERGING ]
//   → decide() → applyDecision()  → optionally reassembleCouncil
// until SETTLED or ESCALATED, then returns the final deliberation.
//
// Tools:
//   - zana_deliberate                — run the full loop
//   - zana_deliberation_status       — load by id
//   - zana_deliberation_list         — list (filter by state)
//   - zana_deliberation_override     — record human override (+SETTLED)
//
// Every external touchpoint is reachable via the optional `deps` argument so
// unit tests can exercise the full loop without booting the daemon.

import {
  collectReviews,
  type CollectedReview,
  type CollectReviewsDeps,
  type VoterSpec,
} from "./collect-reviews";

// ─────────────────────────────────────────────────────────────────────────────
// Lazy module loaders (matches the pattern used in mcp-server.ts).
// ─────────────────────────────────────────────────────────────────────────────
function _work(): any { return require("@zana/work"); }
function _core(): any { return require("@zana/core"); }
function _delib(): any { return _work().deliberation; }

// Hardcoded fallback when runtime-config doesn't carry default voter ids.
// FU-config-3 will land defaultVoterProfileIds in module config; for now any
// profile id may be passed through the args.voters array.
const DEFAULT_VOTER_PROFILE_IDS = ["architect", "security-reviewer", "researcher"];

// ─────────────────────────────────────────────────────────────────────────────
// Common types — exported so handlers in deliberate.test.ts can construct deps.
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliberateDeps extends CollectReviewsDeps {
  // Profile resolution — defaults to @zana/core profileStore.
  getProfile?: (id: string) => any;
  // Probe wiring — defaults to @zana/core agents.manager.
  probeAgent?: (profile: any, probe?: any, deps?: any) => Promise<any>;
  // Where to read context artifacts — defaults to @zana/work runs.artifacts.
  getArtifact?: (id: string) => any;
  // Bound the orchestration loop — guards against runaway state-machine bugs
  // even though decide()/applyDecision() are supposed to terminate.
  // Default: 4 × rounds + 4 (covers REVIEWING + per-round CONVERGING + a few
  // applyDecision retries) — generous but finite.
  maxIterations?: number;
}

export interface DeliberateArgs {
  question: string;
  voters?: string[];
  rounds?: number;
  quorum?: number | "majority" | "all";
  mode?: "synthesis" | "tally";
  riskTag?: "low" | "medium" | "high";
  context?: string[];
  // When true, await the full orchestration loop before returning the final
  // Deliberation record. Default false: return immediately with a stub
  // deliberation in PROPOSED state and let the caller poll
  // zana_deliberation_status. Async-by-default avoids the MCP-client timeout
  // problem that real-Claude voters trip (each can take 5-10 min).
  wait?: boolean;
  deps?: DeliberateDeps;
}

// In-memory tracking of running orchestration loops, keyed by deliberationId.
// Used to (a) prevent double-launching the same deliberation and (b) allow
// future cancellation. Persistence of state already lives in the checkpoint
// store; this map is purely for live-process coordination.
const activeRuns = new Map<string, { startedAt: number }>();

/** Test-only: snapshot active runs (used by deliberate-async.test.ts). */
export function _getActiveRunsForTest(): { deliberationId: string; startedAt: number }[] {
  return Array.from(activeRuns.entries()).map(([deliberationId, info]) => ({
    deliberationId,
    startedAt: info.startedAt,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberate handler
// ─────────────────────────────────────────────────────────────────────────────
export async function deliberateHandler(args: DeliberateArgs): Promise<any> {
  if (!args || typeof args !== "object" || typeof args.question !== "string" || args.question.trim() === "") {
    throw new Error("zana_deliberate: question is required");
  }
  const deps = args.deps ?? {};

  const work = _work();
  const delib = _delib();
  const core = _core();

  const rt = delib.getRuntimeConfig();
  const voterIds = Array.isArray(args.voters) && args.voters.length > 0
    ? args.voters
    : DEFAULT_VOTER_PROFILE_IDS;

  const rounds = typeof args.rounds === "number" && args.rounds >= 1
    ? Math.floor(args.rounds)
    : Math.max(1, Math.floor(rt.defaultRounds));

  // runtime-config carries quorum as a string ("majority"|"all"|"<int>").
  let quorumSpec: number | "majority" | "all";
  if (args.quorum !== undefined) {
    quorumSpec = args.quorum;
  } else {
    const dq = rt.defaultQuorum;
    if (dq === "majority" || dq === "all") quorumSpec = dq;
    else {
      const n = Number(dq);
      quorumSpec = Number.isFinite(n) && n >= 1 ? n : "majority";
    }
  }

  const mode: "synthesis" | "tally" = args.mode === "tally" ? "tally" : (rt.defaultMode || "synthesis");
  const riskTag: "low" | "medium" | "high" = args.riskTag ?? "medium";

  // Resolve profiles up-front — assembleCouncil + collectReviews both need them.
  const getProfile = deps.getProfile ?? ((id: string) => core.agents.profileStore.getProfile(id));
  const candidates: { profileId: string; profile: any }[] = [];
  for (const id of voterIds) {
    const profile = getProfile(id) || getProfile(`built-in-${id}`);
    if (!profile) {
      throw new Error(`zana_deliberate: unknown profile: ${id}`);
    }
    // assembleCouncil rejects duplicate candidate profileIds — surface that here.
    if (candidates.some((c) => c.profileId === id)) {
      throw new Error(`zana_deliberate: duplicate voter profileId: ${id}`);
    }
    candidates.push({ profileId: id, profile });
  }

  // Build prompt snapshot (question + optional context artifacts).
  let promptSnapshot = `# Deliberation\n\n## Question\n${args.question.trim()}\n`;
  if (Array.isArray(args.context) && args.context.length > 0) {
    promptSnapshot += `\n## Context\n`;
    const getArtifact = deps.getArtifact ?? ((id: string) => work.runs.artifacts.getArtifact(id));
    for (const aid of args.context) {
      try {
        const a = getArtifact(aid);
        if (a) {
          promptSnapshot += `\n### Artifact: ${a.title || aid}\n${a.content || ""}\n`;
        }
      } catch {}
    }
  }

  // 1. Propose.
  const proposed = delib.propose({
    question: args.question,
    voters: voterIds.map((id) => ({ profileId: id })),
    rounds,
    quorum: quorumSpec,
    mode,
    riskTag,
    promptSnapshot,
    context: Array.isArray(args.context) && args.context.length > 0
      ? { artifactRefs: [...args.context] }
      : undefined,
  });

  const ctx: RunDeliberationContext = {
    deliberationId: proposed.id,
    candidates,
    promptSnapshot,
    deps,
    rounds,
    getProfile,
  };

  // 2. Default: detach the orchestration loop and return the proposed record.
  //    Caller polls zana_deliberation_status for progress / final outcome.
  if (args.wait !== true) {
    activeRuns.set(proposed.id, { startedAt: Date.now() });
    runDeliberation(ctx).catch(() => {
      // runDeliberation already records ESCALATED on crash; just clear tracker.
    }).finally(() => {
      activeRuns.delete(proposed.id);
    });
    return {
      ...delib.loadDeliberation(proposed.id),
      _outcome: "running",
      _async: true,
    };
  }

  // 3. wait=true — drive the loop inline (legacy / test mode).
  try {
    return await runDeliberation(ctx);
  } finally {
    activeRuns.delete(proposed.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runDeliberation — the orchestration loop.
//
// Pulled out of deliberateHandler so it can run detached from the MCP request
// (default async path) AND inline (wait=true). Crashes inside this function
// must NOT silently leak — record ESCALATED on the deliberation so callers
// polling status see a terminal state.
// ─────────────────────────────────────────────────────────────────────────────
interface RunDeliberationContext {
  deliberationId: string;
  candidates: { profileId: string; profile: any }[];
  promptSnapshot: string;
  deps: DeliberateDeps;
  rounds: number;
  getProfile: (id: string) => any;
}

async function runDeliberation(ctx: RunDeliberationContext): Promise<any> {
  const work = _work();
  const delib = _delib();
  const core = _core();
  const { deliberationId, candidates, promptSnapshot, deps, rounds, getProfile } = ctx;

  try {
    return await runDeliberationUnsafe(ctx);
  } catch (err: any) {
    // Background-runner crash protocol: drive the deliberation to a terminal
    // state so polling callers don't get stuck on REVIEWING/CONVERGING forever.
    try {
      const fresh = delib.loadDeliberation(deliberationId);
      if (fresh && fresh.state !== "SETTLED" && fresh.state !== "ESCALATED" && fresh.state !== "EXHAUSTED") {
        // Attempt a clean transition to ESCALATED. If the legality table
        // forbids it from the current state, swallow — the original error is
        // what we want to surface anyway.
        try {
          delib.transition(deliberationId, "ESCALATED", { escalationReason: "explicit" }, { expectedVersion: fresh.version });
        } catch {}
      }
    } catch {}
    throw err;
  }
}

async function runDeliberationUnsafe(ctx: RunDeliberationContext): Promise<any> {
  const work = _work();
  const delib = _delib();
  const core = _core();
  const { deliberationId, candidates, promptSnapshot, deps, rounds, getProfile } = ctx;

  // 2. Assemble the initial council. assembleCouncil probes each candidate and
  //    transitions PROPOSED → REVIEWING (or PROPOSED → ESCALATED on quorum loss).
  const probeAgent = deps.probeAgent ?? core.agents.manager.probeAgent;
  const assembleDeps: any = {
    probeAgent,
  };
  if (deps.spawnHeadlessAgent) assembleDeps.spawnHeadlessAgent = deps.spawnHeadlessAgent;
  if (deps.getAgent) assembleDeps.getAgent = deps.getAgent;
  if (deps.killAgent) assembleDeps.killAgent = deps.killAgent;

  const assembleOutcome = await delib.assembleCouncil({
    deliberationId,
    candidates,
    deps: assembleDeps,
  });
  if (assembleOutcome.kind === "ESCALATED") {
    return {
      ...delib.loadDeliberation(deliberationId),
      _outcome: "escalated_at_assembly",
      _assemblyEscalation: {
        reason: assembleOutcome.reason,
        details: assembleOutcome.details,
      },
    };
  }

  // 3. Per-round loop.
  const maxIterations = typeof deps.maxIterations === "number" && deps.maxIterations > 0
    ? Math.floor(deps.maxIterations)
    : Math.max(8, rounds * 4 + 4);
  let iter = 0;

  let d: any = delib.loadDeliberation(deliberationId);
  while (d.state === "REVIEWING" || d.state === "CONVERGING") {
    if (++iter > maxIterations) {
      throw new Error(
        `zana_deliberate: orchestration loop exceeded ${maxIterations} iterations on deliberation ${deliberationId} (state=${d.state})`,
      );
    }

    // 3a. Spawn-and-collect reviews for the current round.
    const promptSnapshotForRound = promptSnapshot;
    const voterSpecs: VoterSpec[] = d.voters.map((v: any) => ({
      agentId: v.agentId,
      profileId: v.profileId,
      modelId: v.modelId,
      profile: candidates.find((c) => c.profileId === v.profileId)?.profile ?? getProfile(v.profileId) ?? { id: v.profileId, model: v.modelId },
    }));
    // currentRound is 0 during REVIEWING (synth bumps to 1 → CONVERGING) and
    // 1+ during CONVERGING. Map REVIEWING to round 1 explicitly.
    const round = d.state === "REVIEWING" ? 1 : d.currentRound;

    const reviews = await collectReviews(
      { round, promptSnapshot: promptSnapshotForRound, voters: voterSpecs },
      deps,
    );

    // OCC retry bound — sourced from runtime config so operators can tune it
    // without a code change. Falls back to 3 for safety if config is missing
    // or yields a non-positive value (e.g. test seams that stub the config).
    const occMaxRetries = (() => {
      const v = delib.getRuntimeConfig?.()?.occMaxRetries;
      return typeof v === "number" && v >= 1 ? Math.floor(v) : 3;
    })();

    // 3b. Record votes — each with optimistic-concurrency retry.
    for (const r of reviews) {
      let attempts = 0;
      // applyDecision supports up to occMaxRetries; do the same here.
      while (true) {
        const fresh = delib.loadDeliberation(d.id);
        if (!fresh) throw new Error(`zana_deliberate: deliberation vanished mid-round: ${d.id}`);
        try {
          delib.recordVote(d.id, {
            voterId: r.voterId,
            profileId: r.profileId,
            modelId: r.modelId,
            round: r.round,
            bit: r.bit,
            rationaleHash: r.rationaleHash,
            promptSnapshotHash: fresh.promptSnapshotHash,
            ts: new Date().toISOString(),
          }, { expectedVersion: fresh.version });
          break;
        } catch (err: any) {
          if (err && err.code === "STALE_DELIBERATION" && attempts < occMaxRetries) {
            attempts++;
            continue;
          }
          throw err;
        }
      }
    }

    // 3c. Synthesize on EVERY round — round 1 (REVIEWING → SYNTHESIZING →
    //     CONVERGING) AND rounds 2+ (CONVERGING → CONVERGING with the new
    //     synthesisHash patched in). Without this, CHANGES rationales from
    //     round 2+ would be tallied but never content-addressed or recorded
    //     as dissent — violating the design's "minority report MUST be
    //     preserved, never collapsed" bar (the bug QA caught).
    //
    //     synthesize() filters by deliberation.currentRound; in REVIEWING it's
    //     still 0 but the votes are tagged round=1, so we pass a snapshot with
    //     currentRound aligned to the round we just collected. Pure function —
    //     no state-machine side effects, safe in either state.
    d = delib.loadDeliberation(d.id);
    {
      const snapshotForSynth = { ...d, currentRound: round };
      const synth = delib.synthesize({ deliberation: snapshotForSynth, reviews }, {});

      // Record each dissent with OCC retry — match the recordVote retry
      // pattern. Without retries, a parallel mutation between load+record
      // would surface as STALE_DELIBERATION even though the dissent is safe
      // to append idempotently.
      for (const dis of synth.dissents) {
        let dattempts = 0;
        while (true) {
          const fresh = delib.loadDeliberation(d.id);
          if (!fresh) throw new Error(`zana_deliberate: deliberation vanished mid-round: ${d.id}`);
          try {
            delib.recordDissent(d.id, { ...dis, ts: new Date().toISOString() }, { expectedVersion: fresh.version });
            break;
          } catch (err: any) {
            if (err && err.code === "STALE_DELIBERATION" && dattempts < occMaxRetries) {
              dattempts++;
              continue;
            }
            throw err;
          }
        }
      }

      // Patch synthesisHash onto the deliberation. Two paths:
      //   - Round 1 (state=REVIEWING): REVIEWING → SYNTHESIZING (sets
      //     synthesisHash) → CONVERGING (bumps currentRound to round 1).
      //   - Round 2+ (state=CONVERGING): CONVERGING → CONVERGING self-loop
      //     (legal per TRANSITIONS table) with synthesisHash patched. The
      //     CONVERGING → CONVERGING self-loop already exists for round
      //     bumping; reusing it for round-N synthesis is well-formed because
      //     synthesisHash is in PATCHABLE_FIELDS (see run.ts). No round bump
      //     here — applyDecision/reassembleCouncil drives that on ADVANCE.
      const fresh = delib.loadDeliberation(d.id);
      if (fresh.state === "REVIEWING") {
        delib.transition(d.id, "SYNTHESIZING", { synthesisHash: synth.reportHash }, { expectedVersion: fresh.version });
        const f2 = delib.loadDeliberation(d.id);
        delib.transition(d.id, "CONVERGING", { currentRound: round }, { expectedVersion: f2.version });
      } else {
        // state === "CONVERGING" — patch synthesisHash onto the existing
        // CONVERGING state via the legal CONVERGING → CONVERGING self-loop.
        delib.transition(d.id, "CONVERGING", { synthesisHash: synth.reportHash }, { expectedVersion: fresh.version });
      }
      d = delib.loadDeliberation(d.id);
    }

    // 3d. Decide.
    const decision = delib.decide({ deliberation: d });

    // 3e. Apply.
    if (decision.action === "ADVANCE_ROUND") {
      // Anti-dropout-bias: thread current round's dissenters into reassemble.
      const prevDissenters = d.dissent
        .filter((x: any) => x.round === d.currentRound)
        .map((x: any) => x.profileId);
      // applyDecision would have transitioned to CONVERGING; reassembleCouncil
      // expects the source state to already BE CONVERGING. Drive both:
      //  1) bump currentRound via applyDecision (CONVERGING with currentRound+1)
      //  2) reassemble with previousDissenterProfileIds
      // OR: skip applyDecision and let reassembleCouncil do the round bump.
      // reassembleCouncil only accepts source=CONVERGING, and our current state
      // is CONVERGING, so call it directly.
      const reOutcome = await delib.reassembleCouncil({
        deliberationId: d.id,
        candidates,
        previousDissenterProfileIds: prevDissenters,
        expectedSourceState: "CONVERGING",
        deps: assembleDeps,
      });
      if (reOutcome.kind === "ESCALATED") {
        return {
          ...delib.loadDeliberation(d.id),
          _outcome: "escalated_during_reassembly",
          _reassemblyEscalation: { reason: reOutcome.reason, details: reOutcome.details },
        };
      }
    } else {
      await delib.applyDecision(d.id, decision, { expectedVersion: d.version });
    }

    d = delib.loadDeliberation(d.id);
  }

  return { ...d, _outcome: String(d.state).toLowerCase() };
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberation_status
// ─────────────────────────────────────────────────────────────────────────────
export function deliberationStatusHandler(args: { deliberationId: string }): any {
  if (!args || typeof args.deliberationId !== "string" || args.deliberationId === "") {
    throw new Error("zana_deliberation_status: deliberationId is required");
  }
  const d = _delib().loadDeliberation(args.deliberationId);
  if (!d) throw new Error(`deliberation not found: ${args.deliberationId}`);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberation_list
// ─────────────────────────────────────────────────────────────────────────────
export function deliberationListHandler(args: { state?: string } = {}): any[] {
  const filter: any = {};
  if (typeof args?.state === "string" && args.state !== "") filter.state = args.state;
  const all = _delib().listDeliberations(filter);
  // Return summaries — the full record can be fetched by id via _status.
  return all.map((d: any) => ({
    id: d.id,
    state: d.state,
    question: d.question,
    currentRound: d.currentRound,
    rounds: d.rounds,
    voters: d.voters?.length ?? 0,
    verdict: d.verdict,
    escalationReason: d.escalationReason,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    settledAt: d.settledAt,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// zana_deliberation_override
// ─────────────────────────────────────────────────────────────────────────────
export interface OverrideArgs {
  deliberationId: string;
  decision: "approve" | "reject" | "rework";
  reason: string;
  humanId?: string;
  deps?: { storeContentAddressed?: (bytes: string | Buffer) => { hash: string } };
}

export function deliberationOverrideHandler(args: OverrideArgs): any {
  if (!args || typeof args !== "object") {
    throw new Error("zana_deliberation_override: args required");
  }
  if (typeof args.deliberationId !== "string" || args.deliberationId === "") {
    throw new Error("zana_deliberation_override: deliberationId is required");
  }
  if (args.decision !== "approve" && args.decision !== "reject" && args.decision !== "rework") {
    throw new Error(`zana_deliberation_override: invalid decision: ${String(args.decision)}`);
  }
  if (typeof args.reason !== "string" || args.reason.trim() === "") {
    throw new Error("zana_deliberation_override: reason is required");
  }
  const work = _work();
  const delib = _delib();
  const storeCAS = args.deps?.storeContentAddressed
    ?? ((bytes: string | Buffer) => work.runs.artifacts.storeContentAddressed(bytes));
  const stored = storeCAS(args.reason);

  const d = delib.loadDeliberation(args.deliberationId);
  if (!d) throw new Error(`deliberation not found: ${args.deliberationId}`);

  const updated = delib.recordOverride(args.deliberationId, {
    humanId: args.humanId || "human",
    decision: args.decision,
    reasonHash: stored.hash,
    ts: new Date().toISOString(),
  }, { expectedVersion: d.version });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP tool definitions — registered in mcp-server.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const deliberateTool = {
  name: "zana_deliberate",
  description:
    "Start a multi-voice deliberation: parallel review → synthesis → up-to-N convergence rounds → settle or escalate. " +
    "Each voter is an independent agent with its own profile/model. Dissent is preserved verbatim across EVERY round. " +
    "Default behavior: returns IMMEDIATELY with the proposed deliberation record (state=PROPOSED, _outcome='running'). " +
    "Real-Claude voters can take 5-10 min each; the orchestration loop runs detached on the daemon. " +
    "Poll `zana_deliberation_status({deliberationId})` until state is SETTLED or ESCALATED. " +
    "Pass `wait: true` to block until completion (legacy / scripted use). " +
    "When complete, the deliberation record carries: " +
    "`_outcome` — 'settled' | 'escalated' | 'escalated_at_assembly' | 'escalated_during_reassembly'. " +
    "`_assemblyEscalation` — present only on 'escalated_at_assembly'; { reason, details } describing why the initial council failed to convene (e.g. quorum_lost, all_probes_failed). " +
    "`_reassemblyEscalation` — present only on 'escalated_during_reassembly'; { reason, details } describing why a subsequent round's council failed (e.g. dropout_was_dissenter).",
  inputSchema: {
    type: "object",
    required: ["question"],
    properties: {
      question: { type: "string", description: "What the council is deliberating on." },
      voters: {
        type: "array",
        description: "Voter profile IDs. Defaults to ['architect','security-reviewer','researcher'] when omitted.",
        items: { type: "string" },
      },
      rounds: { type: "number", description: "Hard cap on convergence rounds (default from module config)." },
      quorum: {
        anyOf: [{ type: "string" }, { type: "number" }],
        description: "majority | all | <integer>. Default from module config.",
      },
      mode: {
        type: "string",
        enum: ["synthesis", "tally"],
        description: "Reduction mode (default from module config).",
      },
      riskTag: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "high → mandatory escalation regardless of vote (default 'medium').",
      },
      context: {
        type: "array",
        items: { type: "string" },
        description: "Optional artifact IDs to seed context. Each is read and embedded in the shared prompt.",
      },
      wait: {
        type: "boolean",
        description: "If true, block until the deliberation reaches a terminal state. Default false (async).",
      },
    },
  },
};

export const deliberationStatusTool = {
  name: "zana_deliberation_status",
  description: "Load a deliberation by id and return its full state record.",
  inputSchema: {
    type: "object",
    required: ["deliberationId"],
    properties: {
      deliberationId: { type: "string" },
    },
  },
};

export const deliberationListTool = {
  name: "zana_deliberation_list",
  description: "List deliberation summaries, optionally filtered by state.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: ["PROPOSED", "REVIEWING", "SYNTHESIZING", "CONVERGING", "SETTLED", "ESCALATED", "EXHAUSTED"],
        description: "Filter by deliberation state. Omit to list all.",
      },
    },
  },
};

export const deliberationOverrideTool = {
  name: "zana_deliberation_override",
  description:
    "Record a human override on a deliberation. Stores the reason in the content-addressed artifact store and " +
    "stamps the reasonHash onto the deliberation. Lands the deliberation on SETTLED.",
  inputSchema: {
    type: "object",
    required: ["deliberationId", "decision", "reason"],
    properties: {
      deliberationId: { type: "string" },
      decision: { type: "string", enum: ["approve", "reject", "rework"] },
      reason: { type: "string" },
      humanId: { type: "string", description: "Optional human id. Defaults to 'human'." },
    },
  },
};

// Used by mcp-server.ts to assemble the static TOOLS list.
export const DELIBERATION_TOOLS = [
  deliberateTool,
  deliberationStatusTool,
  deliberationListTool,
  deliberationOverrideTool,
];

// Re-export the collected-review type for tests.
export type { CollectedReview };
