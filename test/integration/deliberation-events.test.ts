import { describe, it, expect } from "vitest";
import { bus, EVENTS } from "@zana-ai/contracts";
import type {
  DeliberationProposedPayload,
  DeliberationVotePayload,
  DeliberationSynthesisPayload,
  DeliberationConvergedPayload,
  DeliberationEscalatedPayload,
  DeliberationOverridePayload,
} from "@zana-ai/core/src/events/deliberation-events.ts";

const NEW_KEYS = [
  "DELIBERATION_PROPOSED",
  "DELIBERATION_VOTE",
  "DELIBERATION_SYNTHESIS",
  "DELIBERATION_CONVERGED",
  "DELIBERATION_ESCALATED",
  "DELIBERATION_OVERRIDE",
] as const;

describe("deliberation events — EVENTS constants", () => {
  it("declares all 6 deliberation:* constants", () => {
    for (const k of NEW_KEYS) {
      expect((EVENTS as Record<string, string>)[k]).toBeDefined();
      expect(typeof (EVENTS as Record<string, string>)[k]).toBe("string");
    }
  });

  it("uses the deliberation:<verb> wire-name pattern", () => {
    for (const k of NEW_KEYS) {
      const v = (EVENTS as Record<string, string>)[k];
      expect(v.startsWith("deliberation:")).toBe(true);
      // Verb portion non-empty, single segment, lower-case.
      const verb = v.slice("deliberation:".length);
      expect(verb.length).toBeGreaterThan(0);
      expect(verb).toMatch(/^[a-z]+$/);
    }
  });

  it("constants are unique strings (no collisions with existing EVENTS)", () => {
    const all = Object.values(EVENTS as Record<string, string>);
    const set = new Set(all);
    expect(set.size).toBe(all.length);

    const delibValues = NEW_KEYS.map((k) => (EVENTS as Record<string, string>)[k]);
    expect(new Set(delibValues).size).toBe(delibValues.length);
  });
});

describe("deliberation events — bus wiring", () => {
  it("emits and receives a deliberation:vote payload", () => {
    const received: DeliberationVotePayload[] = [];
    const handler = (p: DeliberationVotePayload) => { received.push(p); };
    bus.on(EVENTS.DELIBERATION_VOTE, handler);

    const payload: DeliberationVotePayload = {
      deliberationId: "delib-1",
      round: 1,
      voterId: "agent-A",
      profileId: "backend-dev",
      modelId: "claude-opus-4-7",
      bit: "APPROVE",
      rationaleHash: "sha256:abc",
      promptSnapshotHash: "sha256:def",
      ts: "2026-05-19T00:00:00.000Z",
    };

    try {
      bus.emit(EVENTS.DELIBERATION_VOTE, payload);
    } finally {
      bus.off(EVENTS.DELIBERATION_VOTE, handler);
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toStrictEqual(payload);
  });
});

describe("deliberation events — payload shapes (snapshot)", () => {
  it("DeliberationVotePayload structure stays stable", () => {
    const sample: DeliberationVotePayload = {
      deliberationId: "delib-snap",
      round: 2,
      voterId: "voter-X",
      profileId: "reviewer",
      modelId: "claude-sonnet-4-7",
      bit: "CHANGES",
      rationaleHash: "sha256:rat",
      promptSnapshotHash: "sha256:prompt",
      ts: "2026-05-19T12:00:00.000Z",
    };
    expect(JSON.parse(JSON.stringify(sample))).toMatchInlineSnapshot(`
      {
        "bit": "CHANGES",
        "deliberationId": "delib-snap",
        "modelId": "claude-sonnet-4-7",
        "profileId": "reviewer",
        "promptSnapshotHash": "sha256:prompt",
        "rationaleHash": "sha256:rat",
        "round": 2,
        "ts": "2026-05-19T12:00:00.000Z",
        "voterId": "voter-X",
      }
    `);
    // Also confirm the keyset (catches accidental field additions).
    expect(Object.keys(sample).sort()).toStrictEqual([
      "bit",
      "deliberationId",
      "modelId",
      "profileId",
      "promptSnapshotHash",
      "rationaleHash",
      "round",
      "ts",
      "voterId",
    ]);
  });

  it("other deliberation payload types are constructable", () => {
    // Compile-time: if the interfaces drift, these literals stop type-checking.
    const proposed: DeliberationProposedPayload = {
      deliberationId: "d",
      question: "q",
      voters: [{ profileId: "p", agentId: "a" }],
      rounds: 3,
      quorum: 2,
      riskTag: "medium",
      promptSnapshotHash: "sha256:p",
      ts: "2026-05-19T00:00:00.000Z",
    };
    const synthesis: DeliberationSynthesisPayload = {
      deliberationId: "d",
      synthesisHash: "sha256:s",
      tally: { approve: 2, changes: 1 },
      dissentVoterIds: ["a"],
      ts: "2026-05-19T00:00:00.000Z",
    };
    const converged: DeliberationConvergedPayload = {
      deliberationId: "d",
      round: 2,
      verdict: "approve_with_conditions",
      finalTally: { approve: 3, changes: 0 },
      ts: "2026-05-19T00:00:00.000Z",
    };
    const escalated: DeliberationEscalatedPayload = {
      deliberationId: "d",
      reason: "cap_exhausted",
      lastTally: { approve: 1, changes: 2 },
      ts: "2026-05-19T00:00:00.000Z",
    };
    const override: DeliberationOverridePayload = {
      deliberationId: "d",
      humanId: "human-1",
      decision: "rework",
      reason: "needs more evidence",
      reasonHash: "sha256:r",
      ts: "2026-05-19T00:00:00.000Z",
    };
    expect(proposed.voters[0].agentId).toBe("a");
    expect(synthesis.tally.approve).toBe(2);
    expect(converged.verdict).toBe("approve_with_conditions");
    expect(escalated.reason).toBe("cap_exhausted");
    expect(override.decision).toBe("rework");
  });
});
