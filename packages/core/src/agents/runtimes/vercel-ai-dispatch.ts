/**
 * vercel-ai-dispatch — direct dispatcher for ZANA_RUNTIME=vercel-ai workers.
 *
 * Not a RuntimeAdapter. The architect/engineer team review of
 * `.zana/plans/phase-2-wiring.md` (2026-05-28) concluded the full
 * RuntimeAdapter refactor is over-scoped for Phase 3: two of its three
 * AgentHandle gaps (`onStderr`, `onSpawnError`) don't apply to in-process
 * SDK calls. This dispatcher is the smaller fork-and-defer alternative.
 *
 * Contract — what manager.ts:spawnHeadlessAgent expects:
 *   - Same return shape: { agentId, terminalId }
 *   - Same agent record fields populated: state, lastActivity, result,
 *     tokensIn, tokensOut, costUsd, durationMs, numTurns, lastAction
 *   - Same events emitted: AGENT_SPAWNED, AGENT_TERMINATED (via emitTerminated)
 *   - Same persistence: persistAgentRun(agent, exitCode)
 *   - Same retry-bucket plumbing: classifySpawnError on caught errors
 *
 * Multi-turn (`options.multiTurn`) is NOT supported in Phase 3 — the dispatcher
 * throws on first call. writeToAgent in manager.ts already returns false when
 * `agent.childProcess?.stdin?.writable` is falsy, so multi-turn writes silently
 * no-op for vercel-ai workers; this throw is a louder signal at spawn time.
 */

import type { ProbeFailureKind } from "../../events/deliberation-events";

export interface VercelAIDispatchDeps {
  agentId: string;
  terminalId: string;
  cwd: string;
  profile: any;
  routedProfile: any;
  options: any;
  // Shared state from manager.ts — passed to avoid circular imports.
  agents: Map<string, any>;
  notifyChange: () => void;
  getAgent: (id: string) => any;
  emitSpawned: (agentId: string, profileId: string) => void;
  emitTerminated: (
    agentId: string,
    profileId: string,
    reason: "completed" | "errored" | "spawn-error",
    extra?: { exitCode?: number | null; output?: string | null; error?: string }
  ) => void;
  persistAgentRun: (agent: any, exitCode: number | null) => void;
  classifySpawnError: (err: unknown) => ProbeFailureKind;
  agentTimeoutMs: number;
}

export function spawnViaVercelAI(deps: VercelAIDispatchDeps): { agentId: string; terminalId: string } {
  const {
    agentId,
    terminalId,
    profile,
    routedProfile,
    options,
    agents,
    notifyChange,
    getAgent,
    emitSpawned,
    emitTerminated,
    persistAgentRun,
    classifySpawnError,
    agentTimeoutMs,
  } = deps;

  if (options.multiTurn) {
    throw new Error(
      "ZANA_RUNTIME=vercel-ai does not support multi-turn mode in Phase 3. " +
        "Set ZANA_RUNTIME=spawn (default) or omit multiTurn:true."
    );
  }

  // Lazy require so the spawn path doesn't pay the import cost when vercel-ai
  // isn't selected, and so a missing optional dependency surfaces as a clear
  // runtime error rather than a daemon-startup crash.
  let aiModule: any;
  let anthropicModule: any;
  try {
    aiModule = require("ai");
    anthropicModule = require("@ai-sdk/anthropic");
  } catch (err: any) {
    throw new Error(
      `ZANA_RUNTIME=vercel-ai requires the 'ai' and '@ai-sdk/anthropic' packages. ` +
        `Install with: npm install ai @ai-sdk/anthropic. Original error: ${err?.message || err}`
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Surface synchronously so callers see this at spawn time, not after the
    // first generateText() call rejects with an opaque 401.
    throw new Error(
      "ZANA_RUNTIME=vercel-ai requires ANTHROPIC_API_KEY in env. " +
        "Set it in your MCP server env config or export it before running."
    );
  }

  const agent: any = {
    id: agentId,
    profileId: profile.id,
    profileName: profile.displayName,
    profileIcon: profile.icon || "🤖",
    terminalId,
    mode: "headless",
    state: "active",
    model: routedProfile.model || "default",
    pid: null, // No process for in-process SDK calls
    spawnedAt: Date.now(),
    lastActivity: Date.now(),
    toolsAllowed: profile.allowedTools?.length || null,
    toolsTotal: null,
    tokenCount: 0,
    lastAction: "Running (vercel-ai)...",
    parentAgentId: options.parentAgentId || null,
    result: null,
    runtime: "vercel-ai",
  };

  agents.set(agentId, agent);
  notifyChange();
  emitSpawned(agentId, profile.id);

  // Configurable timeout, mirroring spawn path's behavior. Aborts the SDK
  // call via AbortController so generateText settles with an AbortError.
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    if (getAgent(agentId)?.state === "active") {
      console.warn(
        `[agent-manager:vercel-ai] agent ${agentId} timed out after ${agentTimeoutMs / 60000}min, aborting`
      );
      try {
        abortController.abort();
      } catch {}
    }
  }, agentTimeoutMs);

  // Fire-and-forget the generateText promise. The dispatcher returns
  // synchronously like the spawn path; completion is communicated via the
  // AGENT_TERMINATED event and the agent record state field.
  const startedAt = Date.now();
  const modelId = routedProfile.model || "claude-sonnet-4-5-20250929";

  (async () => {
    try {
      const result = await aiModule.generateText({
        model: anthropicModule.anthropic(modelId),
        prompt: options.prompt,
        abortSignal: abortController.signal,
      });

      clearTimeout(timeoutHandle);

      agent.result = result.text || null;
      agent.lastActivity = Date.now();
      agent.durationMs = Date.now() - startedAt;
      if (result.usage) {
        agent.tokensIn = result.usage.promptTokens ?? 0;
        agent.tokensOut = result.usage.completionTokens ?? 0;
      }
      // The Vercel AI SDK does not surface a total_cost_usd field. Cost
      // computation from token counts is provider-specific and intentionally
      // deferred — leaving costUsd unset is correct for now (consumers
      // already treat it as optional).
      agent.numTurns = 1;
      agent.state = "terminated";
      agent.lastAction = "Completed";

      notifyChange();
      emitTerminated(agentId, profile.id, "completed", {
        exitCode: 0,
        output: agent.result,
      });
      const resilienceMod = require("../../modules/loader").getModule?.("resilience");
      resilienceMod?.api?.recordSuccess?.("agent-spawn");
      persistAgentRun(agent, 0);
    } catch (err: any) {
      clearTimeout(timeoutHandle);

      const message = err?.message || String(err);
      console.error(`[agent-manager:vercel-ai] error for ${agentId}:`, message);

      // Use the same classifier the spawn path feeds into — a 401/403 from
      // the provider buckets to "auth", a 429 to "rate_limit", etc. Keeps
      // deliberation T9 retry policy consistent across runtimes.
      const bucket = classifySpawnError(err);
      agent.state = "error";
      agent.lastAction = `Spawn error: ${message}`;
      agent.errorBucket = bucket;
      agent.durationMs = Date.now() - startedAt;

      notifyChange();
      emitTerminated(agentId, profile.id, "spawn-error", { error: message });
      const resilienceMod = require("../../modules/loader").getModule?.("resilience");
      resilienceMod?.api?.recordFailure?.("agent-spawn");
      persistAgentRun(agent, null);
    }
  })();

  return { agentId, terminalId };
}
