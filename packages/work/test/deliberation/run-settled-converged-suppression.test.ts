// Focused test for the DELIBERATION_CONVERGED emission guard in
// transition() — packages/work/src/deliberation/run.ts line 365:
//
//   } else if (to === "SETTLED" && d.verdict && d.verdict !== "escalated") {
//     bus.emit(E.DELIBERATION_CONVERGED, { ... });
//   }
//
// The main run.test.ts pins the POSITIVE path (SETTLED with verdict "approve"
// emits DELIBERATION_CONVERGED). Neither SUPPRESSION branch is covered:
//
//   1. SETTLED with verdict === "escalated" — the deliberation reached a
//      terminal state by escalation, NOT by the council converging, so a
//      "converged" event would be a lie to downstream consumers.
//   2. SETTLED with no verdict at all (the `&& d.verdict` falsy operand).
//
// This file pins both negatives plus a positive control (so the assertions
// can't pass merely because the event never fires). Determinism: uses the real
// core event bus + a throwaway tmp workspace, exactly like run.test.ts — no
// network, no real Claude, no fake clock.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";

describe("transition() — DELIBERATION_CONVERGED emission guard at SETTLED", () => {
  let tmpRoot: string;
  let converged: any[];
  let handler: (payload: any) => void;
  const CONVERGED = core.events.EVENTS.DELIBERATION_CONVERGED;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-delib-converge-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
    converged = [];
    handler = (payload: any) => { converged.push(payload); };
    core.events.bus.on(CONVERGED, handler);
  });

  afterEach(() => {
    core.events.bus.off(CONVERGED, handler);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // Drive a deliberation to CONVERGING, then settle it with `patch`.
  function settleWith(patch: Record<string, any>) {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING");
    run.transition(d.id, "CONVERGING", { currentRound: 1 });
    return run.transition(d.id, "SETTLED", patch);
  }

  it("does NOT emit DELIBERATION_CONVERGED when the SETTLED verdict is 'escalated'", () => {
    const settled = settleWith({ verdict: "escalated" });
    expect(settled.state).toBe("SETTLED");
    expect(settled.verdict).toBe("escalated");
    expect(converged).toHaveLength(0);
  });

  it("does NOT emit DELIBERATION_CONVERGED when SETTLED carries no verdict", () => {
    const settled = settleWith({});
    expect(settled.state).toBe("SETTLED");
    expect(settled.verdict).toBeUndefined();
    expect(converged).toHaveLength(0);
  });

  it("positive control: a real converging verdict ('approve') DOES emit DELIBERATION_CONVERGED", () => {
    const settled = settleWith({ verdict: "approve" });
    expect(settled.state).toBe("SETTLED");
    expect(converged).toHaveLength(1);
    expect(converged[0]).toMatchObject({ deliberationId: settled.id, verdict: "approve", round: 1 });
  });
});
