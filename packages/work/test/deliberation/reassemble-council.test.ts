// reassembleCouncil — between-round re-spawn (T6-FU-1)
//
// Mirrors the assembleCouncil test surface, focusing on the new edges:
//   - source state is REVIEWING or CONVERGING (not PROPOSED);
//   - target state is CONVERGING;
//   - currentRound is incremented;
//   - previousDissenterProfileIds threaded into applyDegradation;
//   - the anti-dropout-bias rule fires on dissenter dropouts (THE governance
//     test — flagged below);
//   - asymmetry vs assembleCouncil: PROPOSED is rejected here.
//
// Uses an injected fakeProbe per the existing pattern.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import * as run from "@zana-ai/work/src/deliberation/run.ts";
import * as quorum from "@zana-ai/work/src/deliberation/quorum.ts";
import * as runtimeConfig from "@zana-ai/work/src/deliberation/runtime-config.ts";

type Outcome = "ok" | "timeout" | "spawn" | "validation" | "misconfig" | "throw";

function fakeProbe(plan: Record<string, Outcome>) {
  return async (profile: any) => {
    const outcome = plan[profile.id] ?? "ok";
    if (outcome === "throw") {
      throw new Error(`fake probe crash for ${profile.id}`);
    }
    if (outcome === "ok") {
      return {
        ok: true,
        latencyMs: 10,
        failures: [],
        modelId: profile.model ?? "unknown",
        probeId: "probe-" + profile.id,
        legs: [],
      };
    }
    return {
      ok: false,
      latencyMs: 10,
      failures: [
        {
          leg: outcome === "misconfig" ? null : "factual",
          kind: outcome,
          reason: `simulated ${outcome}`,
        },
      ],
      modelId: profile.model ?? "unknown",
      probeId: "probe-" + profile.id,
      legs: [],
    };
  };
}

function profileFor(id: string, model = "claude-opus") {
  return { id, displayName: id, model };
}

// Helper: create a deliberation, run a clean initial assemble, then move it to
// CONVERGING (via the synthesis-driven path) so we can exercise reassemble.
async function setupConvergingDeliberation(
  voterIds: string[],
  promptHashSeed = "p",
): Promise<string> {
  const d = run.propose({
    question: "q",
    voters: voterIds.map((id) => ({ profileId: id })),
    promptSnapshot: promptHashSeed,
  });
  await quorum.assembleCouncil({
    deliberationId: d.id,
    candidates: voterIds.map((id) => ({
      profileId: id,
      profile: profileFor(id),
    })),
    deps: { probeAgent: fakeProbe(Object.fromEntries(voterIds.map((id) => [id, "ok"]))) },
  });
  // assemble → REVIEWING. Drive REVIEWING → SYNTHESIZING → CONVERGING manually
  // (no synthesis hash needed for these tests; we just want the source state).
  run.transition(d.id, "SYNTHESIZING");
  run.transition(d.id, "CONVERGING");
  return d.id;
}

describe("reassembleCouncil (T6-FU-1)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-reassemble-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    runtimeConfig.resetRuntimeConfig();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Happy path from CONVERGING
  // ──────────────────────────────────────────────────────────────────────────

  it("reassembleCouncil from CONVERGING with all voters probe-OK → READY, voters[] updated, currentRound incremented", async () => {
    const id = await setupConvergingDeliberation(["a", "b", "c"]);

    const before = run.loadDeliberation(id)!;
    expect(before.state).toBe("CONVERGING");
    const roundBefore = before.currentRound;

    const outcome = await quorum.reassembleCouncil({
      deliberationId: id,
      candidates: [
        { profileId: "a", profile: profileFor("a") },
        { profileId: "b", profile: profileFor("b") },
        { profileId: "c", profile: profileFor("c") },
      ],
      previousDissenterProfileIds: [],
      expectedSourceState: "CONVERGING",
      deps: { probeAgent: fakeProbe({ a: "ok", b: "ok", c: "ok" }) },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;
    expect(outcome.voters).toHaveLength(3);
    expect(outcome.degraded.dropped).toEqual([]);

    const after = run.loadDeliberation(id)!;
    expect(after.state).toBe("CONVERGING");
    expect(after.currentRound).toBe(roundBefore + 1);
    expect(after.voters).toHaveLength(3);
    expect(after.voters.map((v) => v.profileId).sort()).toEqual(["a", "b", "c"]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ⭐ THE governance test: anti-dropout-bias fires on dissenter dropout
  // ──────────────────────────────────────────────────────────────────────────

  it("[GOVERNANCE ⭐] previousDissenterProfileIds=['security-reviewer'] AND security-reviewer drops out → ESCALATED dropout_was_dissenter", async () => {
    const id = await setupConvergingDeliberation([
      "developer",
      "security-reviewer",
      "ux-reviewer",
    ]);

    const outcome = await quorum.reassembleCouncil({
      deliberationId: id,
      candidates: [
        { profileId: "developer", profile: profileFor("developer") },
        { profileId: "security-reviewer", profile: profileFor("security-reviewer") },
        { profileId: "ux-reviewer", profile: profileFor("ux-reviewer") },
      ],
      // The dissenter from round N — must not silently disappear in round N+1.
      previousDissenterProfileIds: ["security-reviewer"],
      expectedSourceState: "CONVERGING",
      deps: {
        // security-reviewer drops; the other two probe OK so quorum would
        // otherwise hold. The whole point of the rule is that quorum holding
        // is NOT enough — the dissenter's voice cannot be silently discarded.
        probeAgent: fakeProbe({
          developer: "ok",
          "security-reviewer": "timeout",
          "ux-reviewer": "ok",
        }),
      },
    });

    expect(outcome.kind).toBe("ESCALATED");
    if (outcome.kind !== "ESCALATED") return;
    expect(outcome.reason).toBe("dropout_was_dissenter");
    expect(outcome.details).toMatch(/profile=security-reviewer/);

    const after = run.loadDeliberation(id)!;
    expect(after.state).toBe("ESCALATED");
    expect(after.escalationReason).toBe("dropout_was_dissenter");
    expect(after.settledAt).toBeDefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Non-trigger: dissenter probes OK → no bias rule, READY
  // ──────────────────────────────────────────────────────────────────────────

  it("previousDissenterProfileIds=['security-reviewer'] AND security-reviewer probes OK → READY (no bias triggered)", async () => {
    const id = await setupConvergingDeliberation([
      "developer",
      "security-reviewer",
      "ux-reviewer",
    ]);

    const outcome = await quorum.reassembleCouncil({
      deliberationId: id,
      candidates: [
        { profileId: "developer", profile: profileFor("developer") },
        { profileId: "security-reviewer", profile: profileFor("security-reviewer") },
        { profileId: "ux-reviewer", profile: profileFor("ux-reviewer") },
      ],
      previousDissenterProfileIds: ["security-reviewer"],
      expectedSourceState: "CONVERGING",
      deps: {
        probeAgent: fakeProbe({
          developer: "ok",
          "security-reviewer": "ok",
          "ux-reviewer": "ok",
        }),
      },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;
    expect(outcome.voters).toHaveLength(3);
    expect(outcome.degraded.dropped).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Source state REVIEWING is also legal
  // ──────────────────────────────────────────────────────────────────────────

  it("reassembleCouncil rejects expectedSourceState='REVIEWING' at the input boundary (typed early-fail, no deep crash)", async () => {
    // Initial assemble lands at REVIEWING — but reassembling from REVIEWING
    // is structurally impossible (T5 forbids REVIEWING → CONVERGING; you must
    // go through SYNTHESIZING). The API rejects this at the input boundary
    // with a clear typed error rather than letting it crash deep in the
    // transition layer.
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });
    await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [
        { profileId: "a", profile: profileFor("a") },
        { profileId: "b", profile: profileFor("b") },
      ],
      deps: { probeAgent: fakeProbe({ a: "ok", b: "ok" }) },
    });
    expect(run.loadDeliberation(d.id)!.state).toBe("REVIEWING");

    await expect(
      quorum.reassembleCouncil({
        deliberationId: d.id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
        ],
        previousDissenterProfileIds: [],
        // @ts-expect-error — testing runtime guard against the dropped value
        expectedSourceState: "REVIEWING",
        deps: { probeAgent: fakeProbe({ a: "ok", b: "ok" }) },
      }),
    ).rejects.toThrow(/expectedSourceState must be "CONVERGING"/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Asymmetry vs assembleCouncil: PROPOSED is REJECTED here
  // ──────────────────────────────────────────────────────────────────────────

  it("reassembleCouncil from PROPOSED throws (wrong source state — go through assembleCouncil instead)", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });
    expect(run.loadDeliberation(d.id)!.state).toBe("PROPOSED");

    // expectedSourceState only accepts REVIEWING | CONVERGING — try CONVERGING
    // (which is what T9 would normally pass), and the source-state guard fires.
    await expect(
      quorum.reassembleCouncil({
        deliberationId: d.id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
        ],
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
        deps: { probeAgent: fakeProbe({ a: "ok", b: "ok" }) },
      }),
    ).rejects.toThrow(/expected state CONVERGING, found PROPOSED/);

    // Also: the input validator rejects "PROPOSED" passed as expectedSourceState.
    await expect(
      quorum.reassembleCouncil({
        deliberationId: d.id,
        candidates: [{ profileId: "a", profile: profileFor("a") }],
        previousDissenterProfileIds: [],
        expectedSourceState: "PROPOSED" as any,
        deps: { probeAgent: fakeProbe({ a: "ok" }) },
      }),
    ).rejects.toThrow(/expectedSourceState must be "CONVERGING"/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SETTLED is rejected (asymmetry)
  // ──────────────────────────────────────────────────────────────────────────

  it("reassembleCouncil from SETTLED throws", async () => {
    const id = await setupConvergingDeliberation(["a", "b"]);
    // Force-settle.
    run.transition(id, "SETTLED");
    expect(run.loadDeliberation(id)!.state).toBe("SETTLED");

    await expect(
      quorum.reassembleCouncil({
        deliberationId: id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
        ],
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
        deps: { probeAgent: fakeProbe({ a: "ok", b: "ok" }) },
      }),
    ).rejects.toThrow(/expected state CONVERGING, found SETTLED/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // quorum_lost after re-probe → ESCALATED
  // ──────────────────────────────────────────────────────────────────────────

  it("reassembleCouncil with quorum_lost after re-probe → ESCALATED quorum_lost", async () => {
    const id = await setupConvergingDeliberation(["a", "b", "c"]);

    const outcome = await quorum.reassembleCouncil({
      deliberationId: id,
      candidates: [
        { profileId: "a", profile: profileFor("a") },
        { profileId: "b", profile: profileFor("b") },
        { profileId: "c", profile: profileFor("c") },
      ],
      previousDissenterProfileIds: [],
      expectedSourceState: "CONVERGING",
      deps: { probeAgent: fakeProbe({ a: "ok", b: "spawn", c: "validation" }) },
    });

    expect(outcome.kind).toBe("ESCALATED");
    if (outcome.kind !== "ESCALATED") return;
    expect(outcome.reason).toBe("quorum_lost");

    const after = run.loadDeliberation(id)!;
    expect(after.state).toBe("ESCALATED");
    expect(after.escalationReason).toBe("quorum_lost");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OCC retry: state advances during re-probe → reload, recompute, clean throw
  // ──────────────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────────
  // T6-FU-3 — degradation entry on reassemble carries post-increment round
  // ──────────────────────────────────────────────────────────────────────────

  it("reassembleCouncil with 1 dropped voter → degradation entry round = currentRound+1, event emitted", async () => {
    const captured: any[] = [];
    const listener = (p: any) => captured.push(p);
    (core as any).events.bus.on(
      (core as any).events.EVENTS.DELIBERATION_DEGRADED,
      listener,
    );

    try {
      const id = await setupConvergingDeliberation(["a", "b", "c"]);
      const before = run.loadDeliberation(id)!;
      const roundBefore = before.currentRound;

      const outcome = await quorum.reassembleCouncil({
        deliberationId: id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
          { profileId: "c", profile: profileFor("c") },
        ],
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
        deps: { probeAgent: fakeProbe({ a: "ok", b: "ok", c: "timeout" }) },
      });
      expect(outcome.kind).toBe("READY");

      const after = run.loadDeliberation(id)!;
      // Reassemble bumps round; degradation entry records the post-increment
      // round (the round that's about to begin).
      expect(after.degradation).toHaveLength(1);
      expect(after.degradation![0].round).toBe(roundBefore + 1);
      expect(after.degradation![0].dropped).toEqual([
        expect.objectContaining({ profileId: "c", reason: "timeout" }),
      ]);

      expect(captured).toHaveLength(1);
      expect(captured[0].round).toBe(roundBefore + 1);
      expect(captured[0].dropped[0].profileId).toBe("c");
    } finally {
      (core as any).events.bus.off(
        (core as any).events.EVENTS.DELIBERATION_DEGRADED,
        listener,
      );
    }
  });

  it("OCC retry: state advances mid-reprobe → reload sees moved-past-source state, throws cleanly", async () => {
    const id = await setupConvergingDeliberation(["a", "b"]);

    let probeCallCount = 0;
    const racingProbe = async (profile: any) => {
      probeCallCount++;
      // On the first probe of the first attempt, sneak in a competing
      // CONVERGING → ESCALATED transition. After reload, source-state guard
      // fires cleanly with "expected CONVERGING, found ESCALATED".
      if (probeCallCount === 1) {
        run.transition(id, "ESCALATED", { escalationReason: "explicit" });
      }
      return {
        ok: true,
        latencyMs: 1,
        failures: [],
        modelId: profile.model ?? "m",
        probeId: "p",
        legs: [],
      };
    };

    await expect(
      quorum.reassembleCouncil({
        deliberationId: id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
        ],
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
        deps: { probeAgent: racingProbe },
      }),
    ).rejects.toThrow(/expected state CONVERGING, found ESCALATED/);
  });
});
