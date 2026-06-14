// Production-barrel test for the deliberation namespace reached through
// packages/work/src/index.ts (the package root barrel).
//
// Gap this closes:
//   - test/index.test.ts asserts only that `workIndex.deliberation` is *truthy*,
//     never that its public functions survive the build.
//   - test/deliberation/index.test.ts pins the surface, but via the Vite SSR
//     `@zana-ai/work/src/...` import — NOT the compiled dist barrel.
//
// Downstream packages consume deliberation as `require("@zana-ai/work").deliberation`,
// which resolves to dist/. So a regression that dropped (or mistyped) an export
// from the deliberation barrel in the *built* artefact would slip past both
// existing suites. This test loads the real dist barrel and locks the
// public-function shape that consumers depend on.
//
// Deterministic: pure require of compiled output — no network, no Claude, no I/O.

import { describe, it, expect } from "vitest";
import * as path from "node:path";

const distIndex = path.resolve(__dirname, "../dist/src/index.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workIndex = require(distIndex) as any;

// The public functions re-exported by src/deliberation/index.ts, grouped by
// origin module. Kept in sync with that barrel's named exports.
const EXPECTED_FUNCTIONS = [
  // runtime-config
  "setRuntimeConfig", "getRuntimeConfig", "resetRuntimeConfig",
  // run (state machine)
  "propose", "transition", "recordVote", "recordDissent", "recordOverride",
  "recordHumanNudge", "loadDeliberation", "listDeliberations", "StaleDeliberationError",
  // round-controller
  "decide", "applyDecision",
  // synthesize
  "synthesize", "canonicalize",
  // quorum
  "assembleCouncil", "reassembleCouncil", "resolveQuorum", "applyDegradation",
  "applyGeneralistSeatInvariant",
  // role-packs
  "listRolePacks", "getRolePack", "resolveVoters", "normalizeVotersInput",
];

describe("@zana-ai/work dist barrel — deliberation namespace surface", () => {
  it("exposes the deliberation namespace as a non-null object", () => {
    expect(workIndex.deliberation).toBeTruthy();
    expect(typeof workIndex.deliberation).toBe("object");
  });

  it.each(EXPECTED_FUNCTIONS)("exposes %s as a function on the dist barrel", (name) => {
    expect(typeof workIndex.deliberation[name]).toBe("function");
  });

  it("exposes TRANSITIONS as a non-empty object", () => {
    const { TRANSITIONS } = workIndex.deliberation;
    expect(TRANSITIONS && typeof TRANSITIONS).toBe("object");
    expect(Object.keys(TRANSITIONS).length).toBeGreaterThan(0);
  });
});
