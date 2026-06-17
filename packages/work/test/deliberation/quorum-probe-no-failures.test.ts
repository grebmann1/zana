// Focused branch test for runProbes' degenerate-result handling in
// packages/work/src/deliberation/quorum.ts (lines ~317-332).
//
// When probeAgent returns `ok: false` but with an EMPTY `failures` array, the
// council assembly must STILL produce a structured drop entry rather than
// silently swallowing the candidate. The implementation falls back to:
//   - reason: "validation"  (first?.kind ?? "validation")
//   - detail: "probe returned ok=false with no failures"
//   - leg:    null
//
// Every other quorum test drives non-ok outcomes through a fake probe that
// always carries a NON-empty failures array, so this fallback branch — and the
// audit-trail guarantee it backs — is otherwise unexercised. A regression here
// would let a malformed probe response escalate with an empty/uninformative
// degradation record, defeating the governance audit trail.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";
import * as quorum from "@zana-ai/work/src/deliberation/quorum.ts";

describe("assembleCouncil — probe returns ok=false with no failures", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-quorum-nf-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("drops the candidate with reason=validation and the documented fallback detail, escalating all_probes_failed", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }],
      promptSnapshot: "p",
    });

    // Degenerate probe result: failed, but with no failure detail at all.
    const noFailuresProbe = async (profile: any) => ({
      ok: false,
      latencyMs: 5,
      failures: [],
      modelId: profile.model ?? "unknown",
      probeId: "probe-" + profile.id,
      legs: [],
    });

    const outcome = await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [{ profileId: "a", profile: { id: "a", model: "claude-opus" } }],
      deps: { probeAgent: noFailuresProbe },
    });

    expect(outcome.kind).toBe("ESCALATED");
    if (outcome.kind !== "ESCALATED") return;
    expect(outcome.reason).toBe("all_probes_failed");

    // The persisted audit trail must still name the dropped voter with a
    // structured, non-empty reason/detail even though the probe gave none.
    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.escalationReason).toBe("all_probes_failed");
    expect(reloaded.degradation).toBeDefined();
    expect(reloaded.degradation!).toHaveLength(1);
    expect(reloaded.degradation![0].dropped).toHaveLength(1);
    expect(reloaded.degradation![0].dropped[0]).toMatchObject({
      profileId: "a",
      reason: "validation",
      detail: "probe returned ok=false with no failures",
      leg: null,
    });
  });
});
