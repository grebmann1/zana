import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana/core/src/project/workspace-context.ts";
import * as core from "@zana/core";
import * as checkpointStore from "@zana/work/src/runs/checkpoint/store.ts";
import * as run from "@zana/work/src/deliberation/run.ts";
import * as quorum from "@zana/work/src/deliberation/quorum.ts";
import * as runtimeConfig from "@zana/work/src/deliberation/runtime-config.ts";
import type { Deliberation } from "@zana/work/src/deliberation/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fake probeAgent — drives test scenarios without spawning real agents.
//
// `plan` maps profileId → outcome:
//   "ok"       → ProbeResult.ok = true
//   "timeout"  → ProbeResult.ok = false, failures: [{kind:"timeout"}]
//   "spawn"    → ProbeResult.ok = false, failures: [{kind:"spawn"}]
//   "validation" → ProbeResult.ok = false, failures: [{kind:"validation"}]
//   "misconfig" → ProbeResult.ok = false, failures: [{kind:"misconfig"}]
//   "throw"    → reject the promise (probe handler crashed)
// ─────────────────────────────────────────────────────────────────────────────
type Outcome = "ok" | "timeout" | "spawn" | "validation" | "misconfig" | "throw";

function fakeProbe(plan: Record<string, Outcome>, modelOverride?: Record<string, string>) {
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
        modelId: modelOverride?.[profile.id] ?? profile.model ?? "unknown",
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

describe("deliberation quorum + graceful degradation (T6)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-quorum-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ──────────────────────────────────────────────────────────────────────────
  // resolveQuorum
  // ──────────────────────────────────────────────────────────────────────────

  it("resolveQuorum: majority/all/integer behave as specified, with edge clamps", () => {
    expect(quorum.resolveQuorum("majority", 3)).toBe(2);
    expect(quorum.resolveQuorum("majority", 4)).toBe(3);
    expect(quorum.resolveQuorum("all", 5)).toBe(5);
    expect(quorum.resolveQuorum(2, 3)).toBe(2);
    // Clamp 0 → 1.
    expect(quorum.resolveQuorum(0, 3)).toBe(1);
    // Clamp 10 over 3 → 3.
    expect(quorum.resolveQuorum(10, 3)).toBe(3);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // assembleCouncil — happy path
  // ──────────────────────────────────────────────────────────────────────────

  it("3 candidates all probe-OK → READY, 3 voters, deliberation transitions to REVIEWING", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      promptSnapshot: "p",
    });

    const outcome = await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [
        { profileId: "a", profile: profileFor("a") },
        { profileId: "b", profile: profileFor("b") },
        { profileId: "c", profile: profileFor("c") },
      ],
      deps: { probeAgent: fakeProbe({ a: "ok", b: "ok", c: "ok" }) },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;
    expect(outcome.voters).toHaveLength(3);
    expect(outcome.degraded.dropped).toEqual([]);

    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.state).toBe("REVIEWING");
    expect(reloaded.voters).toHaveLength(3);
    // Voters carry the resolved modelId from probe result.
    for (const v of reloaded.voters) {
      expect(v.modelId).toBe("claude-opus");
      expect(v.agentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(["a", "b", "c"]).toContain(v.profileId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // assembleCouncil — graceful degradation (quorum still met)
  // ──────────────────────────────────────────────────────────────────────────

  it("3 candidates, 1 probe times out → READY with 2 voters; quorum=2 met, drop reason = timeout", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      promptSnapshot: "p",
    });

    const outcome = await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [
        { profileId: "a", profile: profileFor("a") },
        { profileId: "b", profile: profileFor("b") },
        { profileId: "c", profile: profileFor("c") },
      ],
      deps: { probeAgent: fakeProbe({ a: "ok", b: "ok", c: "timeout" }) },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;
    expect(outcome.voters).toHaveLength(2);
    expect(outcome.degraded.dropped).toEqual([
      expect.objectContaining({ profileId: "c", reason: "timeout" }),
    ]);

    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.state).toBe("REVIEWING");
    expect(reloaded.voters.map((v) => v.profileId).sort()).toEqual(["a", "b"]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // assembleCouncil — quorum lost
  // ──────────────────────────────────────────────────────────────────────────

  it("3 candidates, 2 probe-fail → ESCALATED quorum_lost; deliberation ESCALATED with reason set", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      promptSnapshot: "p",
    });

    const outcome = await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [
        { profileId: "a", profile: profileFor("a") },
        { profileId: "b", profile: profileFor("b") },
        { profileId: "c", profile: profileFor("c") },
      ],
      deps: { probeAgent: fakeProbe({ a: "ok", b: "spawn", c: "validation" }) },
    });

    expect(outcome.kind).toBe("ESCALATED");
    if (outcome.kind !== "ESCALATED") return;
    expect(outcome.reason).toBe("quorum_lost");
    expect(outcome.details).toMatch(/quorum=2/);

    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.state).toBe("ESCALATED");
    expect(reloaded.escalationReason).toBe("quorum_lost");
    expect(reloaded.settledAt).toBeDefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // assembleCouncil — all probes fail
  // ──────────────────────────────────────────────────────────────────────────

  it("3 candidates, all 3 probe-fail → ESCALATED all_probes_failed", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      promptSnapshot: "p",
    });

    const outcome = await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [
        { profileId: "a", profile: profileFor("a") },
        { profileId: "b", profile: profileFor("b") },
        { profileId: "c", profile: profileFor("c") },
      ],
      deps: {
        probeAgent: fakeProbe({ a: "spawn", b: "validation", c: "misconfig" }),
      },
    });

    expect(outcome.kind).toBe("ESCALATED");
    if (outcome.kind !== "ESCALATED") return;
    expect(outcome.reason).toBe("all_probes_failed");

    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.escalationReason).toBe("all_probes_failed");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // assembleCouncil — empty candidate list
  // ──────────────────────────────────────────────────────────────────────────

  it("0 candidates → ESCALATED quorum_lost (cannot make quorum from nothing)", async () => {
    const d = run.propose({
      question: "q",
      voters: [],
      promptSnapshot: "p",
    });

    const outcome = await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [],
      deps: { probeAgent: fakeProbe({}) },
    });

    expect(outcome.kind).toBe("ESCALATED");
    if (outcome.kind !== "ESCALATED") return;
    expect(outcome.reason).toBe("quorum_lost");

    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.state).toBe("ESCALATED");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // applyDegradation — anti-dropout-bias rule (governance gate)
  // ──────────────────────────────────────────────────────────────────────────

  it("applyDegradation: dropped voter's profileId in previousDissenterProfileIds → ESCALATED dropout_was_dissenter even if quorum holds", () => {
    // 3 voters, quorum=2, 1 dropped — quorum still met by survivors. But the
    // dropped one was the previous round's dissenter → escalate anyway.
    const survivors = [
      { agentId: "ag-a", profileId: "a", modelId: "m" },
      { agentId: "ag-b", profileId: "b", modelId: "m" },
    ];
    const dropped = [
      { profileId: "c", reason: "timeout" as const, detail: "..." },
    ];
    const decision = quorum.applyDegradation(survivors, dropped, {
      candidateCount: 3,
      quorum: 2,
      previousDissenterProfileIds: ["c"],
    });
    expect(decision.decision).toBe("ESCALATED");
    expect(decision.reason).toBe("dropout_was_dissenter");
    expect(decision.rationale).toMatch(/profile=c/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // assembleCouncil — wrong source state
  // ──────────────────────────────────────────────────────────────────────────

  it("deliberation not in PROPOSED state → throws clear error", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });
    // Force-advance state outside of T6.
    run.transition(d.id, "REVIEWING");

    await expect(
      quorum.assembleCouncil({
        deliberationId: d.id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
        ],
        deps: { probeAgent: fakeProbe({ a: "ok", b: "ok" }) },
      }),
    ).rejects.toThrow(/expected state PROPOSED, found REVIEWING/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // assembleCouncil — stale concurrency
  // ──────────────────────────────────────────────────────────────────────────

  it("stale concurrency: deliberation advanced between probe and transition → reload, second attempt sees non-PROPOSED state, throws cleanly", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });

    // Probe that advances the deliberation mid-flight (via PROPOSED →
    // EXHAUSTED, the legal cancel path) just before we apply our transition.
    let probeCallCount = 0;
    const racingProbe = async (profile: any) => {
      probeCallCount++;
      // On the FIRST candidate of the FIRST attempt, sneak in a competing
      // transition. After that, the deliberation is no longer PROPOSED, so
      // when we retry after StaleDeliberationError, the reload-PROPOSED guard
      // throws cleanly.
      if (probeCallCount === 1) {
        run.transition(d.id, "EXHAUSTED");
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
      quorum.assembleCouncil({
        deliberationId: d.id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
        ],
        deps: { probeAgent: racingProbe },
      }),
    ).rejects.toThrow(/expected state PROPOSED, found EXHAUSTED/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Voter modelId fidelity
  // ──────────────────────────────────────────────────────────────────────────

  it("Voter records carry the resolved modelId from probe result, not the profile's declared model verbatim", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });

    // Profile declares "claude-opus", but probe reports a different resolved
    // modelId (e.g. routed to opus-4.7). Voter records must reflect probe's.
    const probe = fakeProbe(
      { a: "ok", b: "ok" },
      { a: "claude-opus-4.7", b: "claude-sonnet-4.5" },
    );

    const outcome = await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [
        { profileId: "a", profile: profileFor("a", "claude-opus") },
        { profileId: "b", profile: profileFor("b", "claude-opus") },
      ],
      deps: { probeAgent: probe },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;

    const byProfile = Object.fromEntries(outcome.voters.map((v) => [v.profileId, v]));
    expect(byProfile.a.modelId).toBe("claude-opus-4.7");
    expect(byProfile.b.modelId).toBe("claude-sonnet-4.5");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Duplicate candidates rejected loudly
  // ──────────────────────────────────────────────────────────────────────────

  it("duplicate candidate profileIds are rejected at input (loud > silent dedupe)", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });

    await expect(
      quorum.assembleCouncil({
        deliberationId: d.id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "a", profile: profileFor("a") },
        ],
        deps: { probeAgent: fakeProbe({ a: "ok" }) },
      }),
    ).rejects.toThrow(/duplicate candidate profileId=a/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Probe handler crash → still treated as a drop, no rejection bubble
  // ──────────────────────────────────────────────────────────────────────────

  it("probe handler that throws is treated as a spawn-class drop (Promise.allSettled boundary)", async () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      promptSnapshot: "p",
    });

    const outcome = await quorum.assembleCouncil({
      deliberationId: d.id,
      candidates: [
        { profileId: "a", profile: profileFor("a") },
        { profileId: "b", profile: profileFor("b") },
        { profileId: "c", profile: profileFor("c") },
      ],
      deps: { probeAgent: fakeProbe({ a: "ok", b: "ok", c: "throw" }) },
    });

    // 2 OK + 1 thrown → quorum=2 met → READY with 1 dropped.
    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;
    expect(outcome.voters).toHaveLength(2);
    expect(outcome.degraded.dropped).toHaveLength(1);
    expect(outcome.degraded.dropped[0]).toMatchObject({
      profileId: "c",
      reason: "spawn",
    });
    expect(outcome.degraded.dropped[0].detail).toMatch(/probe threw/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FU-config — assembleCouncil OCC retry budget honors runtime config
  // ──────────────────────────────────────────────────────────────────────────

  describe("FU-config — occMaxRetries from runtime config", () => {
    afterEach(() => {
      runtimeConfig.resetRuntimeConfig();
    });

    it("occMaxRetries=0 → no attempts, immediate 'gave up after 0' error", async () => {
      runtimeConfig.setRuntimeConfig({ occMaxRetries: 0 });
      const d = run.propose({
        question: "q",
        voters: [{ profileId: "a" }, { profileId: "b" }],
        promptSnapshot: "p",
      });
      // The probe is irrelevant since we never enter the loop.
      await expect(
        quorum.assembleCouncil({
          deliberationId: d.id,
          candidates: [
            { profileId: "a", profile: profileFor("a") },
            { profileId: "b", profile: profileFor("b") },
          ],
          deps: { probeAgent: fakeProbe({ a: "ok", b: "ok" }) },
        }),
      ).rejects.toThrow(/gave up after 0 stale-retry attempts/);
    });

    it("occMaxRetries=1 → loop runs once and is reflected in 'gave up after N' error", async () => {
      runtimeConfig.setRuntimeConfig({ occMaxRetries: 1 });
      const d = run.propose({
        question: "q",
        voters: [{ profileId: "a" }, { profileId: "b" }],
        promptSnapshot: "p",
      });

      // Force every attempt to hit StaleDeliberationError by advancing the
      // deliberation mid-probe. After 1 attempt the assembler must give up.
      let probeCallCount = 0;
      const racingProbe = async (profile: any) => {
        probeCallCount++;
        if (probeCallCount === 1) {
          run.transition(d.id, "EXHAUSTED");
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

      // With occMaxRetries=1 the loop runs exactly once. That single attempt
      // probes (which races and bumps the version), then the apply step throws
      // StaleDeliberationError, attempt++ bumps us out of the loop, and we
      // throw "gave up after 1 stale-retry attempts". This is what we want to
      // assert: the budget is honored from runtime config.
      await expect(
        quorum.assembleCouncil({
          deliberationId: d.id,
          candidates: [
            { profileId: "a", profile: profileFor("a") },
            { profileId: "b", profile: profileFor("b") },
          ],
          deps: { probeAgent: racingProbe },
        }),
      ).rejects.toThrow(/gave up after 1 stale-retry attempts/);
    });

    it("occMaxRetries default (3) is honored when config is reset", async () => {
      runtimeConfig.resetRuntimeConfig();
      runtimeConfig.setRuntimeConfig({ occMaxRetries: 0 });
      runtimeConfig.resetRuntimeConfig();

      const d = run.propose({
        question: "q",
        voters: [{ profileId: "a" }, { profileId: "b" }],
        promptSnapshot: "p",
      });
      const outcome = await quorum.assembleCouncil({
        deliberationId: d.id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
        ],
        deps: { probeAgent: fakeProbe({ a: "ok", b: "ok" }) },
      });
      expect(outcome.kind).toBe("READY");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T6-FU-3 — degradation persistence + deliberation:degraded event.
  //
  // Without this, audit consumers can't answer "why is voter X missing from
  // round N?" by reading the deliberation alone — DroppedVoter[] only lived
  // in-memory in assembleCouncil's return value.
  // ──────────────────────────────────────────────────────────────────────────
  describe("T6-FU-3 — degradation audit persistence + event", () => {
    it("assembleCouncil with 1 dropped (timeout) and quorum holds → READY, degradation entry persisted, event emitted", async () => {
      const captured: any[] = [];
      const listener = (p: any) => captured.push(p);
      (core as any).events.bus.on(
        (core as any).events.EVENTS.DELIBERATION_DEGRADED,
        listener,
      );

      try {
        const d = run.propose({
          question: "q",
          voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
          promptSnapshot: "p",
        });
        const outcome = await quorum.assembleCouncil({
          deliberationId: d.id,
          candidates: [
            { profileId: "a", profile: profileFor("a") },
            { profileId: "b", profile: profileFor("b") },
            { profileId: "c", profile: profileFor("c") },
          ],
          deps: { probeAgent: fakeProbe({ a: "ok", b: "ok", c: "timeout" }) },
        });
        expect(outcome.kind).toBe("READY");

        const reloaded = run.loadDeliberation(d.id)!;
        expect(reloaded.degradation).toBeDefined();
        expect(reloaded.degradation!).toHaveLength(1);
        expect(reloaded.degradation![0].dropped).toHaveLength(1);
        expect(reloaded.degradation![0].dropped[0]).toMatchObject({
          profileId: "c",
          reason: "timeout",
        });
        // Initial assemble does not bump round.
        expect(reloaded.degradation![0].round).toBe(0);

        // Event fired exactly once with matching payload.
        expect(captured).toHaveLength(1);
        expect(captured[0].deliberationId).toBe(d.id);
        expect(captured[0].round).toBe(0);
        expect(captured[0].dropped).toHaveLength(1);
        expect(captured[0].dropped[0].reason).toBe("timeout");
        expect(typeof captured[0].ts).toBe("string");
      } finally {
        (core as any).events.bus.off(
          (core as any).events.EVENTS.DELIBERATION_DEGRADED,
          listener,
        );
      }
    });

    it("assembleCouncil with 0 dropped → no degradation entry, no event", async () => {
      const captured: any[] = [];
      const listener = (p: any) => captured.push(p);
      (core as any).events.bus.on(
        (core as any).events.EVENTS.DELIBERATION_DEGRADED,
        listener,
      );

      try {
        const d = run.propose({
          question: "q",
          voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
          promptSnapshot: "p",
        });
        const outcome = await quorum.assembleCouncil({
          deliberationId: d.id,
          candidates: [
            { profileId: "a", profile: profileFor("a") },
            { profileId: "b", profile: profileFor("b") },
            { profileId: "c", profile: profileFor("c") },
          ],
          deps: { probeAgent: fakeProbe({ a: "ok", b: "ok", c: "ok" }) },
        });
        expect(outcome.kind).toBe("READY");

        const reloaded = run.loadDeliberation(d.id)!;
        expect(reloaded.degradation).toBeUndefined();
        expect(captured).toHaveLength(0);
      } finally {
        (core as any).events.bus.off(
          (core as any).events.EVENTS.DELIBERATION_DEGRADED,
          listener,
        );
      }
    });

    it("multiple successful assemblies with drops APPEND to degradation (don't replace)", async () => {
      // First a clean initial assemble that drops one voter.
      const d = run.propose({
        question: "q",
        voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
        promptSnapshot: "p",
      });
      await quorum.assembleCouncil({
        deliberationId: d.id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
          { profileId: "c", profile: profileFor("c") },
        ],
        deps: { probeAgent: fakeProbe({ a: "ok", b: "ok", c: "timeout" }) },
      });

      // Drive REVIEWING → SYNTHESIZING → CONVERGING so we can reassemble.
      run.transition(d.id, "SYNTHESIZING");
      run.transition(d.id, "CONVERGING");

      // Reassemble with another drop. Existing entry must remain.
      await quorum.reassembleCouncil({
        deliberationId: d.id,
        candidates: [
          { profileId: "a", profile: profileFor("a") },
          { profileId: "b", profile: profileFor("b") },
          { profileId: "c", profile: profileFor("c") },
        ],
        previousDissenterProfileIds: [],
        expectedSourceState: "CONVERGING",
        deps: { probeAgent: fakeProbe({ a: "ok", b: "spawn", c: "ok" }) },
      });

      const reloaded = run.loadDeliberation(d.id)!;
      expect(reloaded.degradation).toHaveLength(2);
      expect(reloaded.degradation![0].dropped[0].profileId).toBe("c");
      expect(reloaded.degradation![0].dropped[0].reason).toBe("timeout");
      expect(reloaded.degradation![1].dropped[0].profileId).toBe("b");
      expect(reloaded.degradation![1].dropped[0].reason).toBe("spawn");
    });

    it("DELIBERATION_DEGRADED is registered as a known EVENTS constant", () => {
      // Sanity: contract surface — the constant must exist on EVENTS so
      // listeners can subscribe by name without string-typing.
      const E = (core as any).events.EVENTS;
      expect(E.DELIBERATION_DEGRADED).toBe("deliberation:degraded");
    });
  });
});
