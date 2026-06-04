// Thin facade for the agents/* split. Re-exports the public surface from
// the dedicated lifecycle / dispatch / team-runtime / probe-agent modules so
// existing consumers (tests, @zana-ai/core/index, mcp/, server/, work/,
// intelligence/) can keep importing from "agents/manager".
//
// All real logic lives in:
//   • lifecycle.ts    — spawn/kill/status, probe-overload state
//   • probe-agent.ts  — capability probe (probeAgent, classifySpawnError)
//   • dispatch.ts     — handleOrchestratorCommand (the big switch)
//   • team-runtime.ts — team-start + checkpoint-resume glue
//   • __test-utils__/spawn-overload-probe.ts — _resetSpawnOverloadState /
//                       _testSpawnOverloadProbe (test-only re-exports)

export {
  // Lifecycle: spawn/kill/status + change listeners
  spawnInteractive,
  spawnHeadlessAgent,
  killAgent,
  getAgent,
  listAgents,
  writeToAgent,
  onAgentsChange,
  updateAgentFromHook,
  emitTerminated,
  persistAgentRun,
  // Load gate
  checkSystemResources,
} from "./lifecycle";

export {
  // Probe
  probeAgent,
  classifySpawnError,
  // Probe types
  type ProbeRequest,
  type ProbeLegResult,
  type ProbeResult,
  type ProbeDeps,
  type ProbeFailure,
  type ProbeFailureKind,
} from "./probe-agent";

export { handleOrchestratorCommand } from "./dispatch";

// Test-only re-exports — preserved on the facade so existing test imports
// (`@zana-ai/core/src/agents/manager.ts`) keep working. Production code MUST
// NOT call these.
export {
  _resetSpawnOverloadState,
  _testSpawnOverloadProbe,
} from "./__test-utils__/spawn-overload-probe";
