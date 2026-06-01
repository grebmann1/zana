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
 *
 * Designed AGAINST exploration spirals. Real-Claude voters with full tool
 * access default to "comprehensive audit" mode: 30+ tool calls, 60-min runs,
 * never produce the JSON. The fix isn't more tools or more time — it's
 * framing the role as a council member casting a snap judgment, not an
 * auditor doing a deep review.
 *
 * Key levers in this prompt:
 *   1. Time budget stated UP FRONT (5 min, ≤5 tool calls). Sets the model's
 *      sense of scope before it starts.
 *   2. "Uncertainty IS a CHANGES vote" reframes the cheap escape: when in
 *      doubt, voters can vote CHANGES with "I need more context to confirm
 *      X" rather than spelunking for certainty.
 *   3. The JSON block is described as the FIRST thing the voter should
 *      mentally commit to, not the last. Vote first, justify after.
 *   4. Explicit anti-pattern callouts so the model recognizes its own
 *      failure mode ("If you find yourself reading >5 files, stop").
 *   5. Worked examples reinforce the "vote first, briefly justify" cadence.
 *
 * The output contract is still enforced at the parsing layer
 * (parseVoterOutput) — we tolerate prose around the JSON object so
 * loosely-formatted models still cast a vote.
 */
export function buildVoterPrompt(promptSnapshot: string, voter: VoterSpec): string {
  const lens = voter.profile?.displayName || voter.profileId;
  const lensDescription = voter.profile?.description ? `\n${voter.profile.description}` : "";
  return [
    promptSnapshot.trim(),
    "",
    "## Your role",
    `You are a council member reviewing as the ${lens} (profileId=${voter.profileId}).${lensDescription}`,
    "Cast your vote independently — the council preserves dissent verbatim.",
    "",
    "## ⏱ Budget — read this first",
    "You have ~5 minutes and at most 5 tool calls. This is a council vote,",
    "not an audit. You are ONE voice; other voters are looking at this from",
    "different angles. You don't need exhaustive certainty — you need an",
    "informed snap judgment, the kind you'd give in a 5-minute design review.",
    "",
    "If you find yourself reading more than ~5 files, STOP. You've over-scoped.",
    "Vote CHANGES with 'need more context to confirm X' — that's a legitimate",
    "and useful vote. The council preserves it verbatim and may run another",
    "round; uncertainty is a first-class signal, not a failure.",
    "",
    "## Output contract — REQUIRED",
    "Your message MUST end with EXACTLY one fenced JSON block. Nothing",
    "after the closing ``` fence. The orchestrator will refuse votes that",
    "don't match this shape and record them as a CHANGES timeout-fallback,",
    "so a clean APPROVE/CHANGES vote with a short rationale is always better",
    "than running out of time without producing one.",
    "",
    "Required shape:",
    "```json",
    `{"bit": "APPROVE" | "CHANGES", "rationale": "<= 1000 chars, single string"}`,
    "```",
    "",
    "- `bit: \"APPROVE\"` — the proposal is sound on the dimensions you care about.",
    "- `bit: \"CHANGES\"` — there's a concrete concern, OR you don't have enough",
    "  context to vote APPROVE confidently. Put the concern OR the missing",
    "  context in `rationale`.",
    "",
    "## How to spend your budget (suggested)",
    "1. **Read the question carefully** (~1 min). What's actually being decided?",
    "2. **Form a tentative vote from your role's lens** (~1 min). Don't open files yet.",
    "3. **Targeted check** (~2 min, ≤5 tool calls). Confirm or refute the tentative",
    "   vote with a small number of focused reads — not a survey.",
    "4. **Vote** (~1 min). Write the JSON block.",
    "",
    "If a step takes much longer than its budget, you've over-scoped.",
    "Cut to the JSON block immediately with a CHANGES + 'need more context' rationale.",
    "",
    "## Examples",
    "",
    "Confident APPROVE — vote as the only output:",
    "```json",
    `{"bit": "APPROVE", "rationale": "Schema is internally consistent and the anti-dropout-bias guard at quorum.ts:applyDegradation covers the only failure mode I was concerned about."}`,
    "```",
    "",
    "Confident CHANGES — concrete concern:",
    "```json",
    `{"bit": "CHANGES", "rationale": "Migration loses data: the new NOT NULL column has no default and the backfill runs after the constraint is added. Reorder: backfill first, then ALTER. Also missing rollback path."}`,
    "```",
    "",
    "Uncertainty CHANGES — a fully legitimate vote, NOT a cop-out:",
    "```json",
    `{"bit": "CHANGES", "rationale": "Concept looks reasonable from the architecture lens, but I can't confirm the cost-per-deliberation claim without seeing how synthesisHash gets cached across rounds. Need: example of a real synthesis run with cache stats before I'd APPROVE."}`,
    "```",
    "",
    "End your message with the JSON block. No further prose.",
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
 *   - Multiple JSON-shaped blocks across multi-turn output (returns the LAST
 *     valid {bit, rationale}, which represents the voter's final committed vote)
 * Falls back to {bit:"CHANGES", rationale: <raw output>} on any parse failure
 * — the safe default is "ask the human" rather than silently flipping APPROVE.
 */
export function parseVoterOutput(raw: string | null | undefined): { bit: VoteBit; rationale: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { bit: "CHANGES", rationale: "[parse-fallback] voter produced no output" };
  }
  const candidates: string[] = [];

  // All ```json ... ``` fenced blocks (multi-turn voters may emit several).
  const fencedRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  let m: RegExpExecArray | null;
  while ((m = fencedRe.exec(raw)) !== null) {
    candidates.push(m[1].trim());
  }

  // Bare brace-bounded JSON (greedy enough to capture nested rationales).
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  // Last resort: try the whole string.
  candidates.push(raw.trim());

  // Walk all candidates and keep the LAST valid {bit, rationale}. Voters who
  // narrate after their vote (background tool callbacks etc.) may emit the
  // contract JSON in turn 1 and acknowledgment prose in turn N; if any
  // narration accidentally restates the vote, the last valid one is the
  // canonical decision.
  let last: { bit: VoteBit; rationale: string } | null = null;
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
          last = { bit: bit as VoteBit, rationale };
        }
      }
    } catch {}
  }
  if (last) return last;

  // Couldn't parse — preserve the raw output as rationale and CHANGES-vote.
  return {
    bit: "CHANGES",
    rationale: `[parse-fallback] voter output did not match {bit, rationale} contract:\n${raw.slice(0, 4000)}`,
  };
}

/**
 * Extract every assistant text block from a stream-json transcript.
 *
 * The headless runner overwrites `agent.result` on each assistant turn
 * (manager.ts handles only the latest message). When a voter writes the JSON
 * vote in turn 1 and then continues speaking after a background tool call
 * resolves, `agent.result` ends up holding the post-vote narration only — the
 * vote JSON is gone. The raw stream-json transcript lives in `outputBuffer`,
 * and this helper reconstructs the full assistant-side conversation so the
 * parser can find the vote regardless of which turn carried it.
 *
 * Returns null when the buffer doesn't look like stream-json (so the caller
 * can fall back to the raw buffer as plain prose).
 */
export function extractAssistantTextFromStreamJson(buffer: string | null | undefined): string | null {
  if (typeof buffer !== "string" || buffer.trim() === "") return null;
  const parts: string[] = [];
  let sawAnyJsonLine = false;
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    try {
      const msg = JSON.parse(trimmed);
      sawAnyJsonLine = true;
      if (msg && msg.type === "assistant" && msg.message?.content) {
        const content = Array.isArray(msg.message.content) ? msg.message.content : [];
        for (const block of content) {
          if (block && block.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
          }
        }
      } else if (msg && msg.type === "result" && typeof msg.result === "string") {
        parts.push(msg.result);
      }
    } catch {
      // Non-JSON stdout line — skip.
    }
  }
  if (!sawAnyJsonLine) return null;
  return parts.length === 0 ? "" : parts.join("\n");
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

    // Voters who narrate after their vote (e.g. acknowledging a background
    // tool-call result) overwrite `agent.result` in manager.ts, clobbering the
    // turn that carried the JSON contract. Reconstruct the full assistant-side
    // transcript from the raw stream-json buffer first; that exposes every
    // turn so parseVoterOutput can find the contract block regardless of when
    // it was emitted. Fall back to `result`, then the raw buffer, when the
    // buffer doesn't look like stream-json.
    const transcript = extractAssistantTextFromStreamJson(outcome.outputBuffer);
    const candidate = transcript && transcript.length > 0
      ? transcript
      : outcome.result && outcome.result.length > 0
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
// Lazy default-deps wiring — keeps this module decoupled from @zana-ai/core
// at import time so tests can exercise it without booting the daemon.
// ─────────────────────────────────────────────────────────────────────────────
function _defaultSpawn() {
  return (profile: any, options: any) => {
    const { agents } = require("@zana-ai/core");
    return agents.manager.spawnHeadlessAgent(profile, options);
  };
}
function _defaultGet() {
  return (agentId: string) => {
    const { agents } = require("@zana-ai/core");
    return agents.manager.getAgent(agentId);
  };
}
function _defaultKill() {
  return (agentId: string) => {
    const { agents } = require("@zana-ai/core");
    return agents.manager.killAgent(agentId);
  };
}
function _defaultStoreCAS() {
  return (bytes: string | Buffer) => {
    const work = require("@zana-ai/work");
    return work.runs.artifacts.storeContentAddressed(bytes);
  };
}
