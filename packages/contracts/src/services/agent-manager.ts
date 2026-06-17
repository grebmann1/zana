// IAgentManager — the contract for the agent runtime registry.
//
// Concrete impl: packages/core/src/agents/* (spawner, lifecycle, manager
// facade). This is the most-reached-into core singleton: work/scheduling,
// work/teams, work/tickets (sweeper, watcher), extras/plugins, and mcp all call
// getAgent()/listAgents()/spawn/kill on it (~53 sites). It's also the chief
// blocker to running concerns out-of-process — every reader assumes in-process
// access to live agent state.
//
// Defining the read/lifecycle surface as an interface is the first step toward
// (a) swapping a remote/RPC implementation later and (b) letting callers depend
// on the contract instead of core's concrete manager module.
//
// Type-only module — no runtime code.

/** Live agent state as seen by readers (scheduling overlap gates, watcher
 *  completion checks, sweeper liveness). Loose by design — the full record
 *  lives with the implementation. */
export interface AgentInfo {
  id: string;
  profileName?: string;
  name?: string;
  state: string;
  lastAction?: string;
  mode?: string;
  parentAgentId?: string | null;
  result?: string | null;
  spawnedAt?: number;
  [key: string]: unknown;
}

export interface IAgentManager {
  /** Snapshot of all known agents. */
  listAgents(): AgentInfo[];
  /** A single agent by id, or null/undefined if unknown. */
  getAgent(agentId: string): AgentInfo | null | undefined;
  /** Request termination of an agent. Returns whether a kill was issued. */
  killAgent(agentId: string): boolean;
}
