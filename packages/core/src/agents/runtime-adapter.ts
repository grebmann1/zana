/**
 * RuntimeAdapter — strategy interface for the three planned worker runtimes:
 *
 *   - "spawn":     status quo. Spawn the `claude` binary as a child process.
 *   - "sdk":       Phase 2. Use the Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
 *                  in-process. No binary dependency.
 *   - "vercel-ai": Phase 3. Use the Vercel AI SDK for multi-provider workers.
 *
 * The interface is defined now (Phase 0) so that manager.ts branching is
 * designed against it from the start, rather than retrofitted after the
 * "spawn" implementation has accumulated implicit semantics. No concrete
 * adapters live here yet — those land in Phase 2 / Phase 3.
 *
 * See `.zana/plans/integration-roadmap-v2.md` for context.
 */

export type RuntimeKind = "spawn" | "sdk" | "vercel-ai";

export interface SpawnOptions {
  prompt: string;
  cwd: string;
  terminalId: string;
  profileId: string;
  multiTurn?: boolean;
  parentAgentId?: string | null;
}

/**
 * AgentHandle — the surface manager.ts needs from an adapter to track
 * an in-flight agent. Mirrors today's child-process shape so that
 * ClaudeSpawnAdapter can implement it as a thin wrapper.
 */
export interface AgentHandle {
  pid: number | null;
  kill(signal?: NodeJS.Signals): void;
  /** Write a stream-json message to the agent's input (multi-turn mode). */
  write(jsonMessage: unknown): boolean;
  /** Subscribe to stream-json output lines. */
  onOutput(cb: (line: string) => void): () => void;
  /** Subscribe to exit (code, signal). Fires once. */
  onExit(cb: (code: number | null, signal: string | null) => void): () => void;
}

/**
 * Cost summary emitted by the adapter when the agent terminates.
 * total_cost_usd matches the field the existing UI/cost dashboard parses
 * from the spawn-mode stdout — keep field names stable across runtimes.
 */
export interface AgentCost {
  total_cost_usd: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;

  /**
   * Spawn an agent and return a handle. The adapter is responsible for
   * mapping its internal events (stream-json lines from the binary, SDK
   * callbacks, etc.) onto the AgentHandle observers.
   */
  spawn(profile: unknown, options: SpawnOptions): AgentHandle;

  /**
   * Cheap availability check. Called at runtime selection time to surface
   * a clear error before a worker is spawned (e.g. "claude binary not
   * found on PATH" or "ANTHROPIC_API_KEY not set").
   *
   * Returns null when the runtime is usable, or a human-readable reason.
   */
  checkAvailable(): string | null;
}
