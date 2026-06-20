// Liveness test for the @zana-ai/work dist barrel sub-modules.
//
// Gap this closes:
//   test/index.test.ts asserts each sub-namespace KEY is present via
//   `toHaveProperty`, but `toHaveProperty` passes even if a `require("./x")`
//   in the barrel resolved to an empty `{}` (e.g. a broken path, a renamed
//   file, or a build that dropped the module's exports). Only `runs.anomaly`
//   gets a "this export is actually wired" check (detectAnomalies is a fn).
//   The other sub-modules — tickets/*, scheduling/*, teams/*, runs/* — have no
//   such guard at the barrel level, so a mis-wired require would slip through.
//
// This test loads the real compiled dist barrel (the exact surface downstream
// packages consume via `require("@zana-ai/work")`) and pins, for each
// sub-module, ONE representative public function. If any require resolves to a
// non-module, its representative symbol disappears and this test fails.
//
// Deterministic: pure require of compiled output — no network, no Claude, no I/O.

import { describe, it, expect } from "vitest";
import * as path from "node:path";

const distIndex = path.resolve(__dirname, "../dist/src/index.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workIndex = require(distIndex) as any;

// path-in-barrel -> representative exported function name (kept in sync with
// each sub-module's public surface).
const REPRESENTATIVE: Array<[string, string]> = [
  ["tickets.service", "createTicket"],
  ["tickets.store", "listTickets"],
  ["tickets.db", "saveTicket"],
  ["tickets.migration", "migrateIfNeeded"],
  ["tickets.watcher", "loadRules"],
  ["tickets.sweeper", "sweepOnce"],
  ["scheduling.service", "sweepInflightAgents"],
  ["scheduling.store", "listSchedules"],
  ["scheduling.workflowEngine", "loadRun"],
  ["teams.manager", "startTeam"],
  ["teams.store", "listTeams"],
  ["runs.store", "listRuns"],
  ["runs.tracker", "startRun"],
  ["runs.artifacts", "createArtifact"],
  ["runs.plans", "createPlan"],
  ["runs.checkpoint.store", "save"],
  ["runs.checkpoint.resume", "resume"],
];

function resolve(obj: any, dottedPath: string): any {
  return dottedPath.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

describe("@zana-ai/work dist barrel — sub-module liveness", () => {
  it.each(REPRESENTATIVE)(
    "%s is a live module exposing %s()",
    (modPath, fnName) => {
      const mod = resolve(workIndex, modPath);
      expect(mod, `${modPath} should resolve to a live module`).toBeTruthy();
      expect(
        typeof mod[fnName],
        `${modPath}.${fnName} should be a function (barrel require wired correctly)`,
      ).toBe("function");
    },
  );

  it("scheduling.schema is a live module exposing its field constants", () => {
    // schema exports constants rather than functions; guard one explicitly so
    // the whole scheduling namespace's wiring is covered.
    const { schema } = workIndex.scheduling;
    expect(schema).toBeTruthy();
    expect(Array.isArray(schema.ACTION_TYPES)).toBe(true);
  });

  it("deliberation is a live namespace exposing its public functions", () => {
    // The deliberation namespace is a re-export barrel (`require("./deliberation")`)
    // and is the ONE sub-module the REPRESENTATIVE table above omits. index.test.ts
    // only checks it with toBeTruthy(), which an empty `{}` from a broken require
    // would still pass — so a dropped/mis-wired deliberation barrel slips through at
    // the package-barrel level. Pin representative functions from across its own
    // sub-modules (round-controller, synthesize, quorum, role-packs).
    const { deliberation } = workIndex;
    expect(deliberation, "deliberation should resolve to a live module").toBeTruthy();
    for (const fnName of ["decide", "synthesize", "assembleCouncil", "listRolePacks"]) {
      expect(
        typeof deliberation[fnName],
        `deliberation.${fnName} should be a function (barrel require wired correctly)`,
      ).toBe("function");
    }
  });
});
