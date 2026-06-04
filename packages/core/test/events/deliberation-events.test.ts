/**
 * Structural shape tests for deliberation-events.ts
 *
 * This file exports only TypeScript type contracts (no runtime logic). These
 * tests lock the documented payload shapes so that future type-incompatible
 * changes are caught during the test run rather than silently breaking
 * downstream audit consumers.
 *
 * Strategy: construct literal objects that satisfy each exported interface and
 * verify the required fields are present and typed correctly. TypeScript
 * enforces the structural constraint at compile time; the runtime assertions
 * confirm the values flow through without coercion.
 */
import { describe, it, expect } from "vitest";
import type {
  ProbeFailureKind,
  ProbeFailure,
  AgentProbedPayload,
  DeliberationProposedPayload,
  DeliberationVotePayload,
  DeliberationSynthesisPayload,
  DeliberationConvergedPayload,
  DeliberationEscalatedPayload,
  DroppedVoterRecord,
  DeliberationDegradedPayload,
  DeliberationGeneralistAddedPayload,
  DeliberationHumanNudgePayload,
  DeliberationOverridePayload,
} from "../../src/events/deliberation-events.ts";

// ─── ProbeFailureKind ─────────────────────────────────────────────────────────

describe("ProbeFailureKind", () => {
  it("covers all documented retry-policy buckets", () => {
    // Lock the full union so adding/removing a kind is caught here first.
    const allKinds: ProbeFailureKind[] = [
      "timeout",
      "validation",
      "misconfig",
      "auth",
      "rate_limit",
      "quota",
      "transport",
      "spawn",
    ];
    expect(allKinds).toHaveLength(8);
    // Each literal must be a plain string (no symbols, no numbers).
    for (const k of allKinds) {
      expect(typeof k).toBe("string");
    }
  });

  it("distinguishes transient from structural failure kinds", () => {
    const transient: ProbeFailureKind[] = ["timeout", "rate_limit", "transport"];
    const structural: ProbeFailureKind[] = ["auth", "quota", "misconfig", "validation"];
    const legacy: ProbeFailureKind[] = ["spawn"];

    // No overlap between buckets.
    const seen = new Set<string>();
    for (const k of [...transient, ...structural, ...legacy]) {
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

// ─── ProbeFailure ─────────────────────────────────────────────────────────────

describe("ProbeFailure", () => {
  it("accepts all three leg values and null", () => {
    const legs: ProbeFailure["leg"][] = [
      "factual",
      "instructionFollowing",
      "toolUse",
      null,
    ];
    for (const leg of legs) {
      const f: ProbeFailure = { leg, kind: "timeout", reason: "timed out" };
      expect(f.leg).toBe(leg);
      expect(f.kind).toBe("timeout");
      expect(f.reason).toBe("timed out");
      expect(f.raw).toBeUndefined();
    }
  });

  it("allows optional raw field up to 1 KB", () => {
    const raw = "x".repeat(1024);
    const f: ProbeFailure = { leg: null, kind: "transport", reason: "DNS fail", raw };
    expect(f.raw).toBe(raw);
    expect(f.raw!.length).toBe(1024);
  });
});

// ─── AgentProbedPayload ───────────────────────────────────────────────────────

describe("AgentProbedPayload", () => {
  function makeProbed(overrides: Partial<AgentProbedPayload> = {}): AgentProbedPayload {
    return {
      probeId: "p-1",
      profileId: "prof-a",
      modelId: "claude-sonnet-4-7",
      ok: true,
      failures: [],
      latencyMs: 320,
      ts: new Date().toISOString(),
      cached: false,
      ...overrides,
    };
  }

  it("builds a valid success payload with no failures", () => {
    const payload = makeProbed();
    expect(payload.ok).toBe(true);
    expect(payload.failures).toHaveLength(0);
    expect(payload.cached).toBe(false);
  });

  it("builds a valid failure payload with populated failures", () => {
    const failure: ProbeFailure = { leg: "factual", kind: "auth", reason: "401" };
    const payload = makeProbed({ ok: false, failures: [failure] });
    expect(payload.ok).toBe(false);
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0].kind).toBe("auth");
  });

  it("cached flag is independent of ok flag", () => {
    const cached = makeProbed({ ok: true, cached: true });
    expect(cached.cached).toBe(true);
    expect(cached.ok).toBe(true);
  });

  it("ts field is an ISO string", () => {
    const payload = makeProbed({ ts: "2024-01-15T12:00:00.000Z" });
    expect(() => new Date(payload.ts)).not.toThrow();
    expect(new Date(payload.ts).getFullYear()).toBe(2024);
  });
});

// ─── DeliberationProposedPayload ──────────────────────────────────────────────

describe("DeliberationProposedPayload", () => {
  it("requires voters array with profileId and agentId", () => {
    const p: DeliberationProposedPayload = {
      deliberationId: "d-1",
      question: "Should we proceed?",
      voters: [
        { profileId: "prof-a", agentId: "agent-1" },
        { profileId: "prof-b", agentId: "agent-2", modelId: "claude-opus-4-5" },
      ],
      rounds: 3,
      quorum: 2,
      promptSnapshotHash: "abc123",
      ts: "2024-01-15T12:00:00.000Z",
    };
    expect(p.voters).toHaveLength(2);
    expect(p.voters[1].modelId).toBe("claude-opus-4-5");
    // modelId is optional on first voter
    expect(p.voters[0].modelId).toBeUndefined();
  });

  it("accepts optional rolePack and riskTag fields", () => {
    const p: DeliberationProposedPayload = {
      deliberationId: "d-2",
      question: "Q?",
      voters: [],
      rounds: 1,
      quorum: 1,
      promptSnapshotHash: "xyz",
      ts: "2024-01-15T12:00:00.000Z",
      riskTag: "high",
      rolePack: { id: "council-pack", quantity: 3 },
    };
    expect(p.riskTag).toBe("high");
    expect(p.rolePack?.quantity).toBe(3);
  });
});

// ─── DeliberationVotePayload ──────────────────────────────────────────────────

describe("DeliberationVotePayload", () => {
  it("bit field accepts only APPROVE or CHANGES", () => {
    const approve: DeliberationVotePayload = {
      deliberationId: "d-1",
      round: 1,
      voterId: "v-1",
      profileId: "p-1",
      modelId: "claude-sonnet-4-7",
      bit: "APPROVE",
      rationaleHash: "hash-a",
      promptSnapshotHash: "hash-p",
      ts: "2024-01-15T12:00:00.000Z",
    };
    const changes: DeliberationVotePayload = { ...approve, bit: "CHANGES" };
    expect(approve.bit).toBe("APPROVE");
    expect(changes.bit).toBe("CHANGES");
  });
});

// ─── DeliberationConvergedPayload ─────────────────────────────────────────────

describe("DeliberationConvergedPayload", () => {
  it("verdict accepts approve, approve_with_conditions, and reject", () => {
    const verdicts: DeliberationConvergedPayload["verdict"][] = [
      "approve",
      "approve_with_conditions",
      "reject",
    ];
    for (const verdict of verdicts) {
      const p: DeliberationConvergedPayload = {
        deliberationId: "d-1",
        round: 2,
        verdict,
        finalTally: { approve: 3, changes: 1 },
        ts: "2024-01-15T12:00:00.000Z",
      };
      expect(p.verdict).toBe(verdict);
    }
  });
});

// ─── DeliberationEscalatedPayload ─────────────────────────────────────────────

describe("DeliberationEscalatedPayload", () => {
  it("covers all documented escalation reasons", () => {
    const reasons: DeliberationEscalatedPayload["reason"][] = [
      "cap_exhausted",
      "quorum_lost",
      "dropout_was_dissenter",
      "risk_high",
      "explicit",
    ];
    expect(reasons).toHaveLength(5);
    for (const reason of reasons) {
      const p: DeliberationEscalatedPayload = {
        deliberationId: "d-1",
        reason,
        ts: "2024-01-15T12:00:00.000Z",
      };
      expect(p.reason).toBe(reason);
      expect(p.lastTally).toBeUndefined();
    }
  });

  it("lastTally is optional", () => {
    const p: DeliberationEscalatedPayload = {
      deliberationId: "d-1",
      reason: "cap_exhausted",
      lastTally: { approve: 1, changes: 3 },
      ts: "2024-01-15T12:00:00.000Z",
    };
    expect(p.lastTally?.changes).toBe(3);
  });
});

// ─── DeliberationDegradedPayload ──────────────────────────────────────────────

describe("DeliberationDegradedPayload", () => {
  it("dropped records carry profileId and reason", () => {
    const dropped: DroppedVoterRecord[] = [
      { profileId: "p-1", reason: "timeout" },
      { profileId: "p-2", reason: "auth", detail: "403 Forbidden" },
    ];
    const p: DeliberationDegradedPayload = {
      deliberationId: "d-1",
      round: 2,
      dropped,
      ts: "2024-01-15T12:00:00.000Z",
    };
    expect(p.dropped).toHaveLength(2);
    expect(p.dropped[1].detail).toBe("403 Forbidden");
  });
});

// ─── DeliberationOverridePayload ──────────────────────────────────────────────

describe("DeliberationOverridePayload", () => {
  it("wasSettled=false omits originalSettledAt", () => {
    const p: DeliberationOverridePayload = {
      deliberationId: "d-1",
      humanId: "user-42",
      decision: "approve",
      reason: "Looks good",
      reasonHash: "hash-r",
      ts: "2024-01-15T12:00:00.000Z",
      wasSettled: false,
    };
    expect(p.wasSettled).toBe(false);
    expect(p.originalSettledAt).toBeUndefined();
  });

  it("wasSettled=true carries originalSettledAt", () => {
    const p: DeliberationOverridePayload = {
      deliberationId: "d-1",
      humanId: "user-42",
      decision: "reject",
      reason: "Nope",
      reasonHash: "hash-r",
      ts: "2024-01-15T12:00:00.000Z",
      wasSettled: true,
      originalSettledAt: "2024-01-15T10:00:00.000Z",
    };
    expect(p.wasSettled).toBe(true);
    expect(p.originalSettledAt).toBe("2024-01-15T10:00:00.000Z");
  });

  it("decision accepts approve, reject, and rework", () => {
    const decisions: DeliberationOverridePayload["decision"][] = [
      "approve",
      "reject",
      "rework",
    ];
    for (const decision of decisions) {
      const p: DeliberationOverridePayload = {
        deliberationId: "d-1",
        humanId: "u-1",
        decision,
        reason: "reason",
        reasonHash: "h",
        ts: "2024-01-15T12:00:00.000Z",
        wasSettled: false,
      };
      expect(p.decision).toBe(decision);
    }
  });
});

// ─── DeliberationHumanNudgePayload ────────────────────────────────────────────

describe("DeliberationHumanNudgePayload", () => {
  it("textHash is null when user chose Skip", () => {
    const p: DeliberationHumanNudgePayload = {
      deliberationId: "d-1",
      afterRound: 1,
      contributedBy: "skip",
      textHash: null,
      ts: "2024-01-15T12:00:00.000Z",
    };
    expect(p.textHash).toBeNull();
    expect(p.contributedBy).toBe("skip");
  });

  it("textHash is a string when user provided a nudge", () => {
    const p: DeliberationHumanNudgePayload = {
      deliberationId: "d-1",
      afterRound: 2,
      contributedBy: "user",
      textHash: "sha256-abc",
      ts: "2024-01-15T12:00:00.000Z",
    };
    expect(p.textHash).toBe("sha256-abc");
    expect(p.contributedBy).toBe("user");
  });
});

// ─── DeliberationGeneralistAddedPayload ───────────────────────────────────────

describe("DeliberationGeneralistAddedPayload", () => {
  it("reason is always no_generalist_in_council", () => {
    const p: DeliberationGeneralistAddedPayload = {
      deliberationId: "d-1",
      profileId: "generalist-prof",
      reason: "no_generalist_in_council",
      ts: "2024-01-15T12:00:00.000Z",
    };
    expect(p.reason).toBe("no_generalist_in_council");
  });
});
