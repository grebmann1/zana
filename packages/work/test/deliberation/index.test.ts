// API-surface test for packages/work/src/deliberation/index.ts
//
// Purpose: guard the deliberation public surface against accidental omissions.
// Each assertion checks that a named export is present and is the correct
// kind (function / class / object), without exercising full behaviour
// (individual modules carry those tests).

import { describe, it, expect } from "vitest";
import * as deliberation from "@zana-ai/work/src/deliberation/index.ts";

describe("deliberation public surface", () => {
  // ── runtime-config ────────────────────────────────────────────────────────
  it("exports setRuntimeConfig as a function", () => {
    expect(typeof deliberation.setRuntimeConfig).toBe("function");
  });

  it("exports getRuntimeConfig as a function", () => {
    expect(typeof deliberation.getRuntimeConfig).toBe("function");
  });

  it("exports resetRuntimeConfig as a function", () => {
    expect(typeof deliberation.resetRuntimeConfig).toBe("function");
  });

  // ── state-machine (run.ts) ────────────────────────────────────────────────
  it("exports TRANSITIONS as a non-empty object", () => {
    expect(deliberation.TRANSITIONS).toBeDefined();
    expect(typeof deliberation.TRANSITIONS).toBe("object");
    expect(Object.keys(deliberation.TRANSITIONS).length).toBeGreaterThan(0);
  });

  it("exports propose as a function", () => {
    expect(typeof deliberation.propose).toBe("function");
  });

  it("exports transition as a function", () => {
    expect(typeof deliberation.transition).toBe("function");
  });

  it("exports recordVote as a function", () => {
    expect(typeof deliberation.recordVote).toBe("function");
  });

  it("exports recordDissent as a function", () => {
    expect(typeof deliberation.recordDissent).toBe("function");
  });

  it("exports recordOverride as a function", () => {
    expect(typeof deliberation.recordOverride).toBe("function");
  });

  it("exports recordHumanNudge as a function", () => {
    expect(typeof deliberation.recordHumanNudge).toBe("function");
  });

  it("exports loadDeliberation as a function", () => {
    expect(typeof deliberation.loadDeliberation).toBe("function");
  });

  it("exports listDeliberations as a function", () => {
    expect(typeof deliberation.listDeliberations).toBe("function");
  });

  it("exports StaleDeliberationError as a constructor (deliberationId, expected, actual)", () => {
    expect(typeof deliberation.StaleDeliberationError).toBe("function");
    const err = new deliberation.StaleDeliberationError("d-1", 2, 5);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("d-1");
    expect(err.message).toContain("2");
    expect(err.message).toContain("5");
    expect((err as any).code).toBe("STALE_DELIBERATION");
    expect((err as any).deliberationId).toBe("d-1");
    expect((err as any).expected).toBe(2);
    expect((err as any).actual).toBe(5);
  });

  // ── round-controller ──────────────────────────────────────────────────────
  it("exports decide as a function", () => {
    expect(typeof deliberation.decide).toBe("function");
  });

  it("exports applyDecision as a function", () => {
    expect(typeof deliberation.applyDecision).toBe("function");
  });

  // ── synthesize ────────────────────────────────────────────────────────────
  it("exports synthesize as a function", () => {
    expect(typeof deliberation.synthesize).toBe("function");
  });

  it("exports canonicalize as a function", () => {
    expect(typeof deliberation.canonicalize).toBe("function");
  });

  // ── quorum ────────────────────────────────────────────────────────────────
  it("exports assembleCouncil as a function", () => {
    expect(typeof deliberation.assembleCouncil).toBe("function");
  });

  it("exports reassembleCouncil as a function", () => {
    expect(typeof deliberation.reassembleCouncil).toBe("function");
  });

  it("exports resolveQuorum as a function", () => {
    expect(typeof deliberation.resolveQuorum).toBe("function");
  });

  it("exports applyDegradation as a function", () => {
    expect(typeof deliberation.applyDegradation).toBe("function");
  });

  it("exports applyGeneralistSeatInvariant as a function", () => {
    expect(typeof deliberation.applyGeneralistSeatInvariant).toBe("function");
  });

  // ── role-packs ────────────────────────────────────────────────────────────
  it("exports listRolePacks as a function", () => {
    expect(typeof deliberation.listRolePacks).toBe("function");
  });

  it("exports getRolePack as a function", () => {
    expect(typeof deliberation.getRolePack).toBe("function");
  });

  it("exports resolveVoters as a function", () => {
    expect(typeof deliberation.resolveVoters).toBe("function");
  });

  it("exports normalizeVotersInput as a function", () => {
    expect(typeof deliberation.normalizeVotersInput).toBe("function");
  });
});
