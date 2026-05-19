import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana/core/src/project/workspace-context.ts";
import * as core from "@zana/core";
import * as artifactStore from "@zana/work/src/runs/artifact-store.ts";
import * as checkpointStore from "@zana/work/src/runs/checkpoint/store.ts";
import * as run from "@zana/work/src/deliberation/run.ts";
import * as runtimeConfig from "@zana/work/src/deliberation/runtime-config.ts";
import type { Deliberation, Vote, Dissent } from "@zana/work/src/deliberation/types.ts";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe("deliberation state machine (T5)", () => {
  let tmpRoot: string;
  let busListeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  let captured: Record<string, any[]> = {};

  function listenAll() {
    const bus = core.events.bus;
    const E = core.events.EVENTS;
    const eventNames = [
      E.DELIBERATION_PROPOSED,
      E.DELIBERATION_VOTE,
      E.DELIBERATION_SYNTHESIS,
      E.DELIBERATION_CONVERGED,
      E.DELIBERATION_ESCALATED,
      E.DELIBERATION_OVERRIDE,
    ];
    for (const name of eventNames) {
      captured[name] = [];
      const handler = (payload: any) => { captured[name].push(payload); };
      bus.on(name, handler);
      busListeners.push({ event: name, handler });
    }
  }

  function unlistenAll() {
    const bus = core.events.bus;
    for (const { event, handler } of busListeners) {
      bus.off(event, handler);
    }
    busListeners = [];
    captured = {};
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-delib-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    // Use a deliberation-specific checkpoints dir to avoid colliding with
    // other suites that may share the global ZANA_DIR.
    checkpointStore.init(tmpRoot);
    listenAll();
  });

  afterEach(() => {
    unlistenAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  // ──────────────────────────────────────────────────────────────────────────
  // propose()
  // ──────────────────────────────────────────────────────────────────────────

  it("propose() creates PROPOSED deliberation, persists checkpoint with kind=deliberation + 7d expiry, stores prompt CAS, emits DELIBERATION_PROPOSED", () => {
    const before = Date.now();
    const d = run.propose({
      question: "Adopt argument-based synthesis as the default reducer?",
      voters: [{ profileId: "system-architect" }, { profileId: "backend-dev" }, { profileId: "security-architect" }],
      promptSnapshot: "PROMPT BODY: please vote APPROVE/CHANGES with rationale.",
    });
    const after = Date.now();

    expect(d.state).toBe("PROPOSED");
    expect(d.currentRound).toBe(0);
    expect(d.voters).toEqual([]);            // T6 fills voters at REVIEWING
    expect(d.votes).toEqual([]);
    expect(d.dissent).toEqual([]);
    expect(d.rounds).toBe(2);                 // default
    // 3 voters → majority quorum = 2
    expect(d.quorum).toBe(2);
    expect(d.mode).toBe("synthesis");
    expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.promptSnapshotHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Prompt was content-addressed via T2.
    const blob = artifactStore.readContentAddressed(d.promptSnapshotHash);
    expect(blob).not.toBeNull();
    expect(blob!.toString("utf8")).toContain("PROMPT BODY");

    // Checkpoint persisted with kind="deliberation" and a ~7-day expiry.
    const cp = checkpointStore.load(d.id) as any;
    expect(cp).not.toBeNull();
    expect(cp.kind).toBe("deliberation");
    expect(typeof cp.expiresAt).toBe("number");
    expect(cp.expiresAt).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS - 5_000);
    expect(cp.expiresAt).toBeLessThanOrEqual(after + SEVEN_DAYS_MS + 5_000);
    expect(cp.deliberation.id).toBe(d.id);

    // Event fired.
    const proposed = captured[core.events.EVENTS.DELIBERATION_PROPOSED];
    expect(proposed).toHaveLength(1);
    expect(proposed[0].deliberationId).toBe(d.id);
    expect(proposed[0].promptSnapshotHash).toBe(d.promptSnapshotHash);
    expect(proposed[0].rounds).toBe(2);
    expect(proposed[0].quorum).toBe(2);
    expect(proposed[0].voters).toHaveLength(3);
  });

  it("propose() honors explicit rounds/quorum/mode/riskTag/context", () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      rounds: 3,
      quorum: "all",
      mode: "tally",
      riskTag: "high",
      context: { artifactRefs: ["art-1", "art-2"] },
      promptSnapshot: "snapshot",
    });
    expect(d.rounds).toBe(3);
    expect(d.quorum).toBe(2);
    expect(d.mode).toBe("tally");
    expect(d.riskTag).toBe("high");
    expect(d.context).toEqual({ artifactRefs: ["art-1", "art-2"] });

    const d2 = run.propose({
      question: "q2",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }, { profileId: "d" }],
      quorum: 3,
      promptSnapshot: "s",
    });
    expect(d2.quorum).toBe(3);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // transition() — legality
  // ──────────────────────────────────────────────────────────────────────────

  it("transition() rejects illegal transitions like PROPOSED → SETTLED", () => {
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }],
      promptSnapshot: "p",
    });
    expect(() => run.transition(d.id, "SETTLED")).toThrow(/illegal transition PROPOSED → SETTLED/);
    expect(() => run.transition(d.id, "CONVERGING")).toThrow(/illegal transition/);
    // SYNTHESIZING from PROPOSED is also illegal — review must happen first.
    expect(() => run.transition(d.id, "SYNTHESIZING")).toThrow(/illegal/);
    // PROPOSED → ESCALATED IS legal (T6 council-failed-to-convene path), so
    // we don't assert it here.
  });

  it("transition() rejects transitions out of terminal states", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "EXHAUSTED");
    expect(() => run.transition(d.id, "REVIEWING")).toThrow(/illegal/);

    const d2 = run.propose({ question: "q2", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d2.id, "REVIEWING");
    run.transition(d2.id, "SYNTHESIZING");
    run.transition(d2.id, "CONVERGING");
    run.transition(d2.id, "SETTLED", { verdict: "approve" });
    // SETTLED is terminal under transition().
    expect(() => run.transition(d2.id, "ESCALATED")).toThrow(/illegal/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // transition() — legal flow + events
  // ──────────────────────────────────────────────────────────────────────────

  it("transition() walks the happy path PROPOSED → REVIEWING → SYNTHESIZING → CONVERGING → SETTLED and emits the right events", () => {
    const E = core.events.EVENTS;
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      promptSnapshot: "p",
    });
    run.transition(d.id, "REVIEWING");
    // SYNTHESIZING transition emits DELIBERATION_SYNTHESIS only when synthesisHash is set.
    run.transition(d.id, "SYNTHESIZING", { synthesisHash: "sha256:" + "a".repeat(64) });
    expect(captured[E.DELIBERATION_SYNTHESIS]).toHaveLength(1);
    expect(captured[E.DELIBERATION_SYNTHESIS][0].synthesisHash).toBe("sha256:" + "a".repeat(64));

    run.transition(d.id, "CONVERGING", { currentRound: 1 });
    // No event emitted for plain CONVERGING entry.
    expect(captured[E.DELIBERATION_CONVERGED]).toHaveLength(0);

    const settled = run.transition(d.id, "SETTLED", { verdict: "approve" });
    expect(settled.state).toBe("SETTLED");
    expect(settled.settledAt).toBeDefined();
    expect(captured[E.DELIBERATION_CONVERGED]).toHaveLength(1);
    expect(captured[E.DELIBERATION_CONVERGED][0]).toMatchObject({
      deliberationId: d.id,
      verdict: "approve",
      round: 1,
    });
  });

  it("transition() to ESCALATED emits DELIBERATION_ESCALATED with reason", () => {
    const E = core.events.EVENTS;
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });
    run.transition(d.id, "REVIEWING");
    const after = run.transition(d.id, "ESCALATED", { escalationReason: "risk_high" });
    expect(after.state).toBe("ESCALATED");
    expect(after.escalationReason).toBe("risk_high");
    expect(after.settledAt).toBeDefined();
    expect(captured[E.DELIBERATION_ESCALATED]).toHaveLength(1);
    expect(captured[E.DELIBERATION_ESCALATED][0].reason).toBe("risk_high");
  });

  it("transition() supports CONVERGING → CONVERGING (next round) self-loop", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING");
    run.transition(d.id, "CONVERGING", { currentRound: 1 });
    const next = run.transition(d.id, "CONVERGING", { currentRound: 2 });
    expect(next.state).toBe("CONVERGING");
    expect(next.currentRound).toBe(2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // recordVote / recordDissent / recordOverride
  // ──────────────────────────────────────────────────────────────────────────

  it("recordVote appends to votes[] and emits DELIBERATION_VOTE", () => {
    const E = core.events.EVENTS;
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    const vote: Vote = {
      voterId: "agent-1",
      profileId: "system-architect",
      modelId: "claude-opus",
      round: 1,
      bit: "APPROVE",
      rationaleHash: "sha256:" + "1".repeat(64),
      promptSnapshotHash: d.promptSnapshotHash,
      ts: new Date().toISOString(),
    };
    const after = run.recordVote(d.id, vote);
    expect(after.votes).toHaveLength(1);
    expect(after.votes[0]).toEqual(vote);

    // Persisted.
    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.votes).toHaveLength(1);

    expect(captured[E.DELIBERATION_VOTE]).toHaveLength(1);
    expect(captured[E.DELIBERATION_VOTE][0]).toMatchObject({
      deliberationId: d.id,
      voterId: "agent-1",
      bit: "APPROVE",
      round: 1,
    });
  });

  it("recordVote rejects invalid bit", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    expect(() =>
      run.recordVote(d.id, { ...({} as any), bit: "MAYBE" } as any)
    ).toThrow();
  });

  it("recordDissent appends verbatim minority entries (no event)", () => {
    const E = core.events.EVENTS;
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    const dissent: Dissent = {
      voterId: "agent-2",
      profileId: "security-architect",
      round: 1,
      rationaleHash: "sha256:" + "2".repeat(64),
      ts: new Date().toISOString(),
    };
    const after = run.recordDissent(d.id, dissent);
    expect(after.dissent).toHaveLength(1);
    expect(after.dissent[0]).toEqual(dissent);
    // No dedicated event for dissent — surfaces via SYNTHESIZING.
    expect(captured[E.DELIBERATION_SYNTHESIS]).toHaveLength(0);
  });

  it("recordOverride emits DELIBERATION_OVERRIDE; ESCALATED → SETTLED via override", () => {
    const E = core.events.EVENTS;
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "ESCALATED", { escalationReason: "cap_exhausted" });

    const after = run.recordOverride(d.id, {
      humanId: "user:gr",
      decision: "approve",
      reasonHash: "sha256:" + "3".repeat(64),
      ts: new Date().toISOString(),
    });
    expect(after.override).toBeDefined();
    expect(after.override!.decision).toBe("approve");
    expect(after.state).toBe("SETTLED");
    expect(after.settledAt).toBeDefined();
    expect(captured[E.DELIBERATION_OVERRIDE]).toHaveLength(1);
    expect(captured[E.DELIBERATION_OVERRIDE][0]).toMatchObject({
      deliberationId: d.id,
      humanId: "user:gr",
      decision: "approve",
    });
  });

  it("recordOverride on a SETTLED deliberation adds override block but keeps state SETTLED", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING");
    run.transition(d.id, "CONVERGING", { currentRound: 1 });
    const settled = run.transition(d.id, "SETTLED", { verdict: "approve" });
    expect(settled.state).toBe("SETTLED");
    const settledAtBefore = settled.settledAt;

    const after = run.recordOverride(d.id, {
      humanId: "user:gr",
      decision: "rework",
      reasonHash: "sha256:" + "4".repeat(64),
      ts: new Date().toISOString(),
    });
    expect(after.state).toBe("SETTLED");
    expect(after.settledAt).toBe(settledAtBefore);
    expect(after.override).toBeDefined();
    expect(after.override!.decision).toBe("rework");
    expect(captured[core.events.EVENTS.DELIBERATION_OVERRIDE]).toHaveLength(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // load / list
  // ──────────────────────────────────────────────────────────────────────────

  it("loadDeliberation round-trips after persistence", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    const reloaded = run.loadDeliberation(d.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.id).toBe(d.id);
    expect(reloaded!.state).toBe("PROPOSED");
    expect(reloaded!.promptSnapshotHash).toBe(d.promptSnapshotHash);
  });

  it("loadDeliberation returns null for unknown id", () => {
    expect(run.loadDeliberation("does-not-exist")).toBeNull();
  });

  it("listDeliberations({state}) filters correctly", () => {
    const a = run.propose({ question: "qa", voters: [{ profileId: "a" }], promptSnapshot: "p1" });
    const b = run.propose({ question: "qb", voters: [{ profileId: "a" }], promptSnapshot: "p2" });
    const c = run.propose({ question: "qc", voters: [{ profileId: "a" }], promptSnapshot: "p3" });
    run.transition(b.id, "REVIEWING");
    run.transition(c.id, "REVIEWING");
    run.transition(c.id, "SYNTHESIZING");

    const proposed = run.listDeliberations({ state: "PROPOSED" });
    expect(proposed.map((x: Deliberation) => x.id).sort()).toEqual([a.id].sort());

    const reviewing = run.listDeliberations({ state: "REVIEWING" });
    expect(reviewing.map((x: Deliberation) => x.id)).toEqual([b.id]);

    const synth = run.listDeliberations({ state: "SYNTHESIZING" });
    expect(synth.map((x: Deliberation) => x.id)).toEqual([c.id]);

    const all = run.listDeliberations();
    expect(all.length).toBe(3);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Purity guard: state machine does not spawn agents or mutate runtime
  // ──────────────────────────────────────────────────────────────────────────

  it("state machine is pure-ish: propose() + transition() do not spawn agents", () => {
    const am = (core as any).agents.manager;
    const before = am.listAgents().length;
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      promptSnapshot: "p",
    });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING");
    run.transition(d.id, "CONVERGING", { currentRound: 1 });
    run.transition(d.id, "SETTLED", { verdict: "approve" });
    const after = am.listAgents().length;
    expect(after).toBe(before);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // EXHAUSTED via cancel from PROPOSED
  // ──────────────────────────────────────────────────────────────────────────

  it("PROPOSED → EXHAUSTED is legal (cancel path); state becomes terminal", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    const ex = run.transition(d.id, "EXHAUSTED");
    expect(ex.state).toBe("EXHAUSTED");
    expect(ex.settledAt).toBeDefined();
    expect(() => run.transition(d.id, "REVIEWING")).toThrow(/illegal/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T5a — Optimistic concurrency
  // ──────────────────────────────────────────────────────────────────────────

  it("T5a: version starts at 0 on propose, bumps on every persist", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    expect(d.version).toBe(0);
    const after1 = run.transition(d.id, "REVIEWING");
    expect(after1.version).toBe(1);
    const vote: Vote = {
      voterId: "agent-1",
      profileId: "a",
      modelId: "m",
      round: 1,
      bit: "APPROVE",
      rationaleHash: "sha256:" + "a".repeat(64),
      promptSnapshotHash: d.promptSnapshotHash,
      ts: new Date().toISOString(),
    };
    const after2 = run.recordVote(d.id, vote);
    expect(after2.version).toBe(2);
    const after3 = run.recordDissent(d.id, {
      voterId: "agent-2",
      profileId: "b",
      round: 1,
      rationaleHash: "sha256:" + "b".repeat(64),
      ts: new Date().toISOString(),
    });
    expect(after3.version).toBe(3);
  });

  it("T5a: transition with stale expectedVersion throws StaleDeliberationError", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    expect(d.version).toBe(0);
    expect(() => run.transition(d.id, "REVIEWING", undefined, { expectedVersion: 99 })).toThrow(
      run.StaleDeliberationError,
    );
    // Sanity: matching version succeeds.
    const after = run.transition(d.id, "REVIEWING", undefined, { expectedVersion: 0 });
    expect(after.state).toBe("REVIEWING");
    expect(after.version).toBe(1);
  });

  it("T5a: recordVote with stale expectedVersion throws, no vote written", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    const fresh = run.loadDeliberation(d.id)!;
    const vote: Vote = {
      voterId: "agent-1",
      profileId: "a",
      modelId: "m",
      round: 1,
      bit: "APPROVE",
      rationaleHash: "sha256:" + "1".repeat(64),
      promptSnapshotHash: d.promptSnapshotHash,
      ts: new Date().toISOString(),
    };
    expect(() => run.recordVote(d.id, vote, { expectedVersion: fresh.version - 1 })).toThrow(
      run.StaleDeliberationError,
    );
    const reloaded = run.loadDeliberation(d.id)!;
    expect(reloaded.votes).toHaveLength(0);
  });

  it("T5a: concurrent recordVote — second caller throws STALE, first vote persisted", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    // Both callers load the same version.
    const a = run.loadDeliberation(d.id)!;
    const b = run.loadDeliberation(d.id)!;
    expect(a.version).toBe(b.version);
    const v0 = a.version;

    const voteA: Vote = {
      voterId: "agent-A",
      profileId: "pA",
      modelId: "m",
      round: 1,
      bit: "APPROVE",
      rationaleHash: "sha256:" + "a".repeat(64),
      promptSnapshotHash: d.promptSnapshotHash,
      ts: new Date().toISOString(),
    };
    const voteB: Vote = { ...voteA, voterId: "agent-B", profileId: "pB", bit: "CHANGES" };

    // First caller wins.
    run.recordVote(d.id, voteA, { expectedVersion: v0 });
    // Second caller, still using stale v0, must throw.
    let threw: any = null;
    try { run.recordVote(d.id, voteB, { expectedVersion: v0 }); } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(run.StaleDeliberationError);
    expect(threw.code).toBe("STALE_DELIBERATION");
    expect(threw.expected).toBe(v0);

    const final = run.loadDeliberation(d.id)!;
    expect(final.votes).toHaveLength(1);
    expect(final.votes[0].voterId).toBe("agent-A");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T5b — transition() patch allowlist
  // ──────────────────────────────────────────────────────────────────────────

  it("T5b: transition rejects patch with non-patchable field (id)", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    expect(() =>
      run.transition(d.id, "REVIEWING", { id: "tampered" } as any),
    ).toThrow(/not patchable/);
  });

  it("T5b: transition rejects patch with non-patchable field (votes/state/createdAt)", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    expect(() =>
      run.transition(d.id, "REVIEWING", { votes: [] } as any),
    ).toThrow(/not patchable/);
    expect(() =>
      run.transition(d.id, "REVIEWING", { state: "SETTLED" } as any),
    ).toThrow(/not patchable/);
    expect(() =>
      run.transition(d.id, "REVIEWING", { createdAt: "2020-01-01T00:00:00Z" } as any),
    ).toThrow(/not patchable/);
    expect(() =>
      run.transition(d.id, "REVIEWING", { version: 99 } as any),
    ).toThrow(/not patchable/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T5c — recordVote/recordDissent state guards
  // ──────────────────────────────────────────────────────────────────────────

  function makeVote(d: Deliberation, round = 1): Vote {
    return {
      voterId: "agent-X",
      profileId: "p",
      modelId: "m",
      round,
      bit: "APPROVE",
      rationaleHash: "sha256:" + "f".repeat(64),
      promptSnapshotHash: d.promptSnapshotHash,
      ts: new Date().toISOString(),
    };
  }
  function makeDissent(round = 1): Dissent {
    return {
      voterId: "agent-X",
      profileId: "p",
      round,
      rationaleHash: "sha256:" + "e".repeat(64),
      ts: new Date().toISOString(),
    };
  }

  it("T5c: recordVote rejects on PROPOSED", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    expect(() => run.recordVote(d.id, makeVote(d))).toThrow(/cannot record vote in state PROPOSED/);
  });

  it("T5c: recordVote rejects on SETTLED", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING");
    run.transition(d.id, "CONVERGING", { currentRound: 1 });
    run.transition(d.id, "SETTLED", { verdict: "approve" });
    expect(() => run.recordVote(d.id, makeVote(d))).toThrow(/cannot record vote in state SETTLED/);
  });

  it("T5c: recordVote rejects on EXHAUSTED", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "EXHAUSTED");
    expect(() => run.recordVote(d.id, makeVote(d))).toThrow(/cannot record vote in state EXHAUSTED/);
  });

  it("T5c: recordDissent rejects on PROPOSED", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    expect(() => run.recordDissent(d.id, makeDissent())).toThrow(/cannot record dissent in state PROPOSED/);
  });

  it("T5c: recordDissent allowed during SYNTHESIZING", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING");
    const after = run.recordDissent(d.id, makeDissent());
    expect(after.dissent).toHaveLength(1);
  });

  it("T5c: recordDissent allowed during ESCALATED", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "ESCALATED", { escalationReason: "explicit" });
    const after = run.recordDissent(d.id, makeDissent());
    expect(after.dissent).toHaveLength(1);
  });

  it("T7-FU-a: recordDissent stamps ts when caller passes Dissent without ts", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    // synthesize() returns Dissent objects with ts="" — persistence boundary
    // (recordDissent) is responsible for stamping the canonical wallclock.
    const tsless: Dissent = {
      voterId: "agent-Y",
      profileId: "p",
      round: 1,
      rationaleHash: "sha256:" + "f".repeat(64),
      ts: "",
    };
    const before = Date.now();
    const after = run.recordDissent(d.id, tsless);
    const afterMs = Date.now();
    expect(after.dissent).toHaveLength(1);
    const stamped = after.dissent[0].ts;
    expect(typeof stamped).toBe("string");
    expect(stamped).not.toBe("");
    const parsed = Date.parse(stamped);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(afterMs + 1000);
  });

  it("T7-FU-a: recordDissent preserves caller-provided ts when present", () => {
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    const explicit = "2026-04-01T12:00:00.000Z";
    const after = run.recordDissent(d.id, {
      voterId: "agent-Z",
      profileId: "p",
      round: 1,
      rationaleHash: "sha256:" + "9".repeat(64),
      ts: explicit,
    });
    expect(after.dissent[0].ts).toBe(explicit);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T5d — DELIBERATION_SYNTHESIS event uses computeTallyForRound
  // ──────────────────────────────────────────────────────────────────────────

  it("T5d: DELIBERATION_SYNTHESIS payload carries real tally from current round", () => {
    const E = core.events.EVENTS;
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      promptSnapshot: "p",
    });
    run.transition(d.id, "REVIEWING");
    // Three votes in round 1: 2 APPROVE, 1 CHANGES.
    const baseTs = new Date().toISOString();
    run.recordVote(d.id, {
      voterId: "v1", profileId: "a", modelId: "m", round: 1, bit: "APPROVE",
      rationaleHash: "sha256:" + "1".repeat(64), promptSnapshotHash: d.promptSnapshotHash, ts: baseTs,
    });
    run.recordVote(d.id, {
      voterId: "v2", profileId: "b", modelId: "m", round: 1, bit: "APPROVE",
      rationaleHash: "sha256:" + "2".repeat(64), promptSnapshotHash: d.promptSnapshotHash, ts: baseTs,
    });
    run.recordVote(d.id, {
      voterId: "v3", profileId: "c", modelId: "m", round: 1, bit: "CHANGES",
      rationaleHash: "sha256:" + "3".repeat(64), promptSnapshotHash: d.promptSnapshotHash, ts: baseTs,
    });
    // Bump currentRound to 1 so computeTallyForRound counts these votes.
    run.transition(d.id, "SYNTHESIZING", {
      synthesisHash: "sha256:" + "9".repeat(64),
      currentRound: 1,
    });
    const ev = captured[E.DELIBERATION_SYNTHESIS];
    expect(ev).toHaveLength(1);
    expect(ev[0].tally).toEqual({ approve: 2, changes: 1 });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T5e — DELIBERATION_OVERRIDE payload carries wasSettled + originalSettledAt
  // ──────────────────────────────────────────────────────────────────────────

  it("T5e: override on ESCALATED emits {wasSettled: false}", () => {
    const E = core.events.EVENTS;
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "ESCALATED", { escalationReason: "explicit" });
    run.recordOverride(d.id, {
      humanId: "user:g",
      decision: "approve",
      reasonHash: "sha256:" + "5".repeat(64),
      ts: new Date().toISOString(),
    });
    const ev = captured[E.DELIBERATION_OVERRIDE];
    expect(ev).toHaveLength(1);
    expect(ev[0].wasSettled).toBe(false);
    expect(ev[0].originalSettledAt).toBeUndefined();
  });

  it("T5e: override on SETTLED emits {wasSettled: true, originalSettledAt: <original>}", () => {
    const E = core.events.EVENTS;
    const d = run.propose({ question: "q", voters: [{ profileId: "a" }], promptSnapshot: "p" });
    run.transition(d.id, "REVIEWING");
    run.transition(d.id, "SYNTHESIZING");
    run.transition(d.id, "CONVERGING", { currentRound: 1 });
    const settled = run.transition(d.id, "SETTLED", { verdict: "approve" });
    const originalSettledAt = settled.settledAt!;
    expect(originalSettledAt).toBeDefined();

    run.recordOverride(d.id, {
      humanId: "user:g",
      decision: "rework",
      reasonHash: "sha256:" + "6".repeat(64),
      ts: new Date().toISOString(),
    });
    const ev = captured[E.DELIBERATION_OVERRIDE];
    expect(ev).toHaveLength(1);
    expect(ev[0].wasSettled).toBe(true);
    expect(ev[0].originalSettledAt).toBe(originalSettledAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FU-config — propose() honors runtime config defaults
// ─────────────────────────────────────────────────────────────────────────────
describe("propose() honors runtime config (FU-config)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-delib-rcfg-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });
  afterEach(() => {
    runtimeConfig.resetRuntimeConfig();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("propose() with no rounds picks defaultRounds from runtime config", () => {
    runtimeConfig.setRuntimeConfig({ defaultRounds: 5 });
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });
    expect(d.rounds).toBe(5);
  });

  it("propose() with no quorum picks defaultQuorum=all from runtime config", () => {
    runtimeConfig.setRuntimeConfig({ defaultQuorum: "all" });
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      promptSnapshot: "p",
    });
    // "all" with 3 voters → quorum = 3
    expect(d.quorum).toBe(3);
  });

  it("propose() with no quorum picks defaultQuorum=integer-as-string", () => {
    runtimeConfig.setRuntimeConfig({ defaultQuorum: "2" });
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }, { profileId: "d" }],
      promptSnapshot: "p",
    });
    expect(d.quorum).toBe(2);
  });

  it("propose() with no mode picks defaultMode=tally from runtime config", () => {
    runtimeConfig.setRuntimeConfig({ defaultMode: "tally" });
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }],
      promptSnapshot: "p",
    });
    expect(d.mode).toBe("tally");
  });

  it("checkpoint expiry honors runtime config checkpointTTLDays", () => {
    runtimeConfig.setRuntimeConfig({ checkpointTTLDays: 14 });
    const before = Date.now();
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }],
      promptSnapshot: "p",
    });
    const after = Date.now();
    const cp = checkpointStore.load(d.id) as any;
    const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
    expect(cp.expiresAt).toBeGreaterThanOrEqual(before + FOURTEEN_DAYS_MS - 5_000);
    expect(cp.expiresAt).toBeLessThanOrEqual(after + FOURTEEN_DAYS_MS + 5_000);
  });

  it("explicit propose() args still override runtime config", () => {
    runtimeConfig.setRuntimeConfig({
      defaultRounds: 5,
      defaultQuorum: "all",
      defaultMode: "tally",
    });
    const d = run.propose({
      question: "q",
      voters: [{ profileId: "a" }, { profileId: "b" }, { profileId: "c" }],
      rounds: 3,
      quorum: 2,
      mode: "synthesis",
      promptSnapshot: "p",
    });
    expect(d.rounds).toBe(3);
    expect(d.quorum).toBe(2);
    expect(d.mode).toBe("synthesis");
  });
});
