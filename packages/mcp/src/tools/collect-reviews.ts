// T9 — Spawn-and-collect glue for zana_deliberate.
//
// For each Voter on the deliberation, spawn a headless agent with a prompt
// that includes (a) the shared promptSnapshot, (b) the voter's role lens, and
// (c) an explicit JSON output contract. Wait for each agent to terminate (or
// timeout), parse the final JSON, and content-address the rationale.
//
// Returns one VoterReview per voter (always — failures collapse to a CHANGES
// vote whose rationale captures the parse/runtime error). The caller (T9
// `zana_deliberate` orchestrator) records each review via run.recordVote and
// feeds them to synthesize() for the round.
//
// Dependency injection: every external touchpoint (spawn / get / kill agents,
// profile resolution, content-addressed store) is reachable via the optional
// `deps` argument so unit tests can run without spawning real Claude.

export type VoteBit = "APPROVE" | "CHANGES";

export interface CollectReviewsDeps {
  spawnHeadlessAgent?: (profile: any, options: any) => { agentId: string; terminalId?: string };
  getAgent?: (agentId: string) => any;
  killAgent?: (agentId: string) => boolean;
  storeContentAddressed?: (bytes: string | Buffer) => { hash: string };
  // Per-voter timeout in ms; defaults to 600000 (10 min).
  timeoutMs?: number;
  // Polling interval while waiting for agent termination. Tests can shrink
  // this to keep total runtime tiny.
  pollIntervalMs?: number;
}

export interface VoterSpec {
  // run.Voter fields, threaded through from the deliberation record.
  agentId: string;          // = Voter.agentId (assigned at REVIEWING)
  profileId: string;
  modelId: string;
  // The resolved profile object (callers already loaded it during assembly).
  profile: any;
}

export interface CollectReviewsInput {
  round: number;
  promptSnapshot: string;
  voters: VoterSpec[];
}

export interface CollectedReview {
  voterId: string;          // = the spawned agent's id (NOT Voter.agentId — that
                            // was a placeholder until the voter actually ran).
                            // Vote.voterId stores this so audits can resolve
                            // rationale → run record.
  profileId: string;
  modelId: string;
  round: number;
  bit: VoteBit;
  rationale: string;
  rationaleHash: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the per-voter prompt: shared snapshot + role + explicit JSON contract.
 * The output contract is enforced at the parsing layer (parseVoterOutput) — we
 * tolerate prose around the JSON object so loosely-formatted models still vote.
 */
export function buildVoterPrompt(promptSnapshot: string, voter: VoterSpec): string {
  const lens = voter.profile?.displayName || voter.profileId;
  const lensDescription = voter.profile?.description ? `\n${voter.profile.description}` : "";
  return [
    promptSnapshot.trim(),
    "",
    "## Your role",
    `You are reviewing as the ${lens} (profileId=${voter.profileId}).${lensDescription}`,
    "Cast your vote independently — the council preserves dissent verbatim.",
    "",
    "## Output contract",
    "Reply with EXACTLY one JSON object as your final message, no prose around it:",
    "```json",
    `{"bit": "APPROVE" | "CHANGES", "rationale": "<your reasoning>"}`,
    "```",
    "Use APPROVE only if the proposal is correct and complete as written.",
    "Use CHANGES if anything needs revision; put the requested changes in `rationale`.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Output parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract {bit, rationale} from an agent's final stdout. Tolerates:
 *   - bare JSON (`{"bit":"APPROVE",...}`)
 *   - JSON in a fenced code block
 *   - JSON embedded in surrounding prose
 * Falls back to {bit:"CHANGES", rationale: <raw output>} on any parse failure
 * — the safe default is "ask the human" rather than silently flipping APPROVE.
 */
export function parseVoterOutput(raw: string | null | undefined): { bit: VoteBit; rationale: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { bit: "CHANGES", rationale: "[parse-fallback] voter produced no output" };
  }
  const candidates: string[] = [];

  // ```json ... ``` fenced block
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenced) candidates.push(fenced[1].trim());

  // Bare brace-bounded JSON (greedy enough to capture nested rationales).
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  // Last resort: try the whole string.
  candidates.push(raw.trim());

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") {
        const bit = String(parsed.bit || "").toUpperCase();
        if (bit === "APPROVE" || bit === "CHANGES") {
          const rationale =
            typeof parsed.rationale === "string" && parsed.rationale.trim() !== ""
              ? parsed.rationale
              : "[no rationale provided]";
          return { bit: bit as VoteBit, rationale };
        }
      }
    } catch {}
  }

  // Couldn't parse — preserve the raw output as rationale and CHANGES-vote.
  return {
    bit: "CHANGES",
    rationale: `[parse-fallback] voter output did not match {bit, rationale} contract:\n${raw.slice(0, 4000)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling helper — wait for terminal state or timeout.
// ─────────────────────────────────────────────────────────────────────────────

interface PollOutcome {
  state: string;
  result: string | null;
  outputBuffer: string | null;
}

function _pollAgent(
  agentId: string,
  deadline: number,
  get: (id: string) => any,
  pollIntervalMs: number,
): Promise<PollOutcome> {
  return new Promise((resolve) => {
    const tick = () => {
      const ag = get(agentId);
      if (!ag) {
        resolve({ state: "missing", result: null, outputBuffer: null });
        return;
      }
      const buf = typeof ag.outputBuffer === "string" ? ag.outputBuffer : null;
      const terminal = ag.state === "terminated" || ag.state === "errored" || ag.state === "error";
      if (terminal) {
        resolve({
          state: ag.state,
          result: typeof ag.result === "string" ? ag.result : null,
          outputBuffer: buf,
        });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({
          state: "timeout",
          result: typeof ag.result === "string" ? ag.result : null,
          outputBuffer: buf,
        });
        return;
      }
      setTimeout(tick, pollIntervalMs);
    };
    tick();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn each voter in parallel, await their final outputs, parse + content-
 * address each rationale, and return one CollectedReview per voter. Always
 * returns `voters.length` reviews — failures collapse to a CHANGES vote whose
 * rationale captures the failure mode.
 */
export async function collectReviews(
  input: CollectReviewsInput,
  deps: CollectReviewsDeps = {},
): Promise<CollectedReview[]> {
  const spawn = deps.spawnHeadlessAgent ?? _defaultSpawn();
  const get = deps.getAgent ?? _defaultGet();
  const kill = deps.killAgent ?? _defaultKill();
  const storeCAS = deps.storeContentAddressed ?? _defaultStoreCAS();
  const timeoutMs = typeof deps.timeoutMs === "number" && deps.timeoutMs > 0
    ? Math.floor(deps.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = typeof deps.pollIntervalMs === "number" && deps.pollIntervalMs > 0
    ? Math.floor(deps.pollIntervalMs)
    : DEFAULT_POLL_MS;

  // Run all voters in parallel — order is preserved on resolution via the index.
  const promises = input.voters.map(async (v): Promise<CollectedReview> => {
    const prompt = buildVoterPrompt(input.promptSnapshot, v);
    let agentId: string | null = null;
    let outcome: PollOutcome = { state: "missing", result: null, outputBuffer: null };
    try {
      const spawned = spawn(v.profile, { prompt });
      agentId = spawned.agentId;
      const deadline = Date.now() + timeoutMs;
      outcome = await _pollAgent(agentId, deadline, get, pollIntervalMs);
    } catch (err: any) {
      // Spawn failed — record as CHANGES with the spawn error preserved.
      const rationale = `[spawn-error] ${err?.message || String(err)}`;
      const stored = storeCAS(rationale);
      return {
        voterId: agentId ?? `${v.profileId}:spawn-failed`,
        profileId: v.profileId,
        modelId: v.modelId,
        round: input.round,
        bit: "CHANGES",
        rationale,
        rationaleHash: stored.hash,
      };
    }

    if (outcome.state === "timeout") {
      try { if (agentId) kill(agentId); } catch {}
      const rationale = `[timeout] voter exceeded ${timeoutMs}ms without terminating`;
      const stored = storeCAS(rationale);
      return {
        voterId: agentId!,
        profileId: v.profileId,
        modelId: v.modelId,
        round: input.round,
        bit: "CHANGES",
        rationale,
        rationaleHash: stored.hash,
      };
    }

    // stream-json may not have populated `result`; fall back to outputBuffer.
    const candidate = outcome.result && outcome.result.length > 0
      ? outcome.result
      : outcome.outputBuffer;
    const { bit, rationale } = parseVoterOutput(candidate);
    const stored = storeCAS(rationale);

    return {
      voterId: agentId!,
      profileId: v.profileId,
      modelId: v.modelId,
      round: input.round,
      bit,
      rationale,
      rationaleHash: stored.hash,
    };
  });

  return Promise.all(promises);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy default-deps wiring — keeps this module decoupled from @zana/core
// at import time so tests can exercise it without booting the daemon.
// ─────────────────────────────────────────────────────────────────────────────
function _defaultSpawn() {
  return (profile: any, options: any) => {
    const { agents } = require("@zana/core");
    return agents.manager.spawnHeadlessAgent(profile, options);
  };
}
function _defaultGet() {
  return (agentId: string) => {
    const { agents } = require("@zana/core");
    return agents.manager.getAgent(agentId);
  };
}
function _defaultKill() {
  return (agentId: string) => {
    const { agents } = require("@zana/core");
    return agents.manager.killAgent(agentId);
  };
}
function _defaultStoreCAS() {
  return (bytes: string | Buffer) => {
    const work = require("@zana/work");
    return work.runs.artifacts.storeContentAddressed(bytes);
  };
}
