// Test-only helpers for the spawn-overload streak counter that lives in
// agents/lifecycle.ts. These are exposed via manager.ts (the facade) so the
// existing public surface — test imports of `_resetSpawnOverloadState` and
// `_testSpawnOverloadProbe` from "@zana-ai/core/src/agents/manager.ts" —
// continues to work after the manager-split.
//
// Production code MUST NOT import from this file. The streak counter shared
// state lives in lifecycle.ts; these helpers reach into it for unit tests
// that exercise record/clear/limit logic without going through
// handleOrchestratorCommand (which dynamically requires many modules
// unavailable in unit-test scope).

import {
  spawnOverloadStreaks,
  recordSpawnOverload,
  clearSpawnOverloadStreak,
  getSpawnThrottleStreakLimit,
} from "../lifecycle";

// Reset all counters between tests.
export function _resetSpawnOverloadState() {
  spawnOverloadStreaks.clear();
}

// Probe for the streak counter.
export function _testSpawnOverloadProbe(
  op: "record" | "clear" | "limit",
  parentAgentId?: string | null,
) {
  if (op === "record") return recordSpawnOverload(parentAgentId);
  if (op === "clear") {
    clearSpawnOverloadStreak(parentAgentId);
    return 0;
  }
  if (op === "limit") return getSpawnThrottleStreakLimit();
  return 0;
}
