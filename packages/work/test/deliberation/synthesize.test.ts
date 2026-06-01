import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as checkpointStore from "@zana-ai/work/src/runs/checkpoint/store.ts";
import { synthesize, canonicalize } from "@zana-ai/work/src/deliberation/synthesize.ts";
import type {
  VoterReview,
  SynthesizeOptions,
} from "@zana-ai/work/src/deliberation/synthesize.ts";
import type { Deliberation } from "@zana-ai/work/src/deliberation/types.ts";

function makeDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: "delib-test",
    state: "REVIEWING",
    question: "Should we ship X?",
    voters: [],
    rounds: 2,
    quorum: 2,
    mode: "synthesis",
    promptSnapshotHash: "sha256:" + "0".repeat(64),
    currentRound: 1,
    votes: [],
    dissent: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0,
    ...overrides,
  };
}

function makeReview(overrides: Partial<VoterReview> = {}): VoterReview {
  return {
    voterId: "voter-1",
    profileId: "system-architect",
    modelId: "claude-opus",
    round: 1,
    bit: "CHANGES",
    rationaleHash: "sha256:" + "1".repeat(64),
    rationale: "Some rationale text.",
    ...overrides,
  };
}

describe("deliberation synthesize reducer (T7)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-synth-"));
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    checkpointStore.init(tmpRoot);
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("3 voters: 2 find the same blocker, 1 unique → 1 consensus CRITICAL + 1 unique", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        profileId: "system-architect",
        bit: "CHANGES",
        rationale: "- Critical blocker: missing CSRF token allows session hijack",
        rationaleHash: "sha256:" + "a".repeat(64),
      }),
      makeReview({
        voterId: "v2",
        profileId: "security-architect",
        bit: "CHANGES",
        rationale: "- Critical: CSRF token missing, session hijack possible",
        rationaleHash: "sha256:" + "b".repeat(64),
      }),
      makeReview({
        voterId: "v3",
        profileId: "backend-dev",
        bit: "APPROVE",
        rationale: "- Consider renaming the variable for readability",
        rationaleHash: "sha256:" + "c".repeat(64),
      }),
    ];

    const out = synthesize({ deliberation, reviews });

    expect(out.report.findings).toHaveLength(2);
    const consensus = out.report.findings.find((f) => f.category === "consensus");
    expect(consensus).toBeDefined();
    expect(consensus!.severity).toBe("CRITICAL");
    expect(consensus!.sourceVoterIds.sort()).toEqual(["v1", "v2"]);

    const unique = out.report.findings.find((f) => f.category === "unique");
    expect(unique).toBeDefined();
    expect(unique!.sourceVoterIds).toEqual(["v3"]);
    expect(unique!.severity).toBe("MINOR");
  });

  it("severity heuristic categorizes 'security: missing CSRF token' as CRITICAL", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        rationale: "security: missing CSRF token",
        bit: "CHANGES",
      }),
    ];
    const out = synthesize({ deliberation, reviews });
    expect(out.report.findings).toHaveLength(1);
    expect(out.report.findings[0].severity).toBe("CRITICAL");
  });

  it("consensus across voters merges sourceVoterIds and picks max severity", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        // "should" → MAJOR
        rationale: "- The retry loop should backoff exponentially with jitter",
        bit: "CHANGES",
      }),
      makeReview({
        voterId: "v2",
        // "must" → CRITICAL — group should pick CRITICAL
        rationale: "- The retry loop must backoff exponentially with jitter",
        bit: "CHANGES",
      }),
      makeReview({
        voterId: "v3",
        rationale: "- Consider exponential backoff with jitter on retry loop",
        bit: "CHANGES",
      }),
    ];

    const out = synthesize({ deliberation, reviews });
    const consensus = out.report.findings.find((f) => f.category === "consensus");
    expect(consensus).toBeDefined();
    expect(consensus!.sourceVoterIds.sort()).toEqual(["v1", "v2", "v3"]);
    expect(consensus!.severity).toBe("CRITICAL");
  });

  it("disagreement: voter A says 'X is broken', voter B says 'X is fine' → disagreement", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        rationale: "- The cache invalidation logic is broken",
        bit: "CHANGES",
      }),
      makeReview({
        voterId: "v2",
        rationale: "- The cache invalidation logic is fine",
        bit: "APPROVE",
      }),
    ];

    const out = synthesize({ deliberation, reviews });
    expect(out.report.findings).toHaveLength(1);
    expect(out.report.findings[0].category).toBe("disagreement");
    expect(out.report.findings[0].sourceVoterIds.sort()).toEqual(["v1", "v2"]);
  });

  it("tally is correct for 2 APPROVE / 1 CHANGES", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({ voterId: "v1", bit: "APPROVE", rationale: "looks good" }),
      makeReview({ voterId: "v2", bit: "APPROVE", rationale: "ship it" }),
      makeReview({ voterId: "v3", bit: "CHANGES", rationale: "- must fix the auth bug" }),
    ];
    const out = synthesize({ deliberation, reviews });
    expect(out.report.tally).toEqual({ approve: 2, changes: 1 });
  });

  it("dissents includes only CHANGES voters, with verbatim rationaleHash", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "APPROVE",
        rationale: "ok",
        rationaleHash: "sha256:" + "1".repeat(64),
      }),
      makeReview({
        voterId: "v2",
        profileId: "security-architect",
        bit: "CHANGES",
        rationale: "- security concern, must fix",
        rationaleHash: "sha256:" + "2".repeat(64),
      }),
      makeReview({
        voterId: "v3",
        profileId: "backend-dev",
        bit: "CHANGES",
        rationale: "- API contract is wrong",
        rationaleHash: "sha256:" + "3".repeat(64),
      }),
    ];

    const out = synthesize({ deliberation, reviews });
    expect(out.dissents).toHaveLength(2);
    const byVoter = new Map(out.dissents.map((d) => [d.voterId, d]));
    expect(byVoter.get("v2")!.rationaleHash).toBe("sha256:" + "2".repeat(64));
    expect(byVoter.get("v2")!.profileId).toBe("security-architect");
    expect(byVoter.get("v2")!.round).toBe(1);
    expect(byVoter.get("v3")!.rationaleHash).toBe("sha256:" + "3".repeat(64));
    expect(byVoter.has("v1")).toBe(false);
    expect(out.report.dissentVoterIds.sort()).toEqual(["v2", "v3"]);
  });

  it("T7-FU-a: reportHash is byte-for-byte deterministic for identical input", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationale: "- must fix the security bug in login flow",
        rationaleHash: "sha256:" + "a".repeat(64),
      }),
      makeReview({
        voterId: "v2",
        bit: "APPROVE",
        rationale: "looks fine to me",
        rationaleHash: "sha256:" + "b".repeat(64),
      }),
    ];

    // No stripping — the new contract is that reportHash itself is
    // deterministic because canonicalize() drops `ts` from the hashed bytes.
    const out1 = synthesize({ deliberation, reviews });
    const out2 = synthesize({ deliberation, reviews });

    expect(out1.reportHash).toBe(out2.reportHash);
    expect(out1.reportBytes).toBe(out2.reportBytes);
    // The hashed bytes MUST NOT contain `ts` — that's the whole point.
    expect(JSON.parse(out1.reportBytes)).not.toHaveProperty("ts");
  });

  it("T7-FU-a: report.ts is present in returned report and recent, but excluded from hash", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({ voterId: "v1", bit: "APPROVE", rationale: "fine" }),
    ];
    const before = Date.now();
    const out = synthesize({ deliberation, reviews });
    const after = Date.now();

    // Consumer-visible ts is present and ISO-8601, within ~1s of the call.
    expect(typeof out.report.ts).toBe("string");
    expect(out.report.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const stamped = Date.parse(out.report.ts);
    expect(Number.isFinite(stamped)).toBe(true);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(after + 1000);

    // But the hashed bytes do NOT contain ts.
    const parsed = JSON.parse(out.reportBytes);
    expect(parsed).not.toHaveProperty("ts");
  });

  it("T7-FU-a: dissents returned by synthesize carry no caller-set ts (recordDissent stamps it)", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationale: "- must fix the bug",
        rationaleHash: "sha256:" + "a".repeat(64),
      }),
      makeReview({
        voterId: "v2",
        bit: "CHANGES",
        rationale: "- still broken",
        rationaleHash: "sha256:" + "b".repeat(64),
      }),
    ];
    const out = synthesize({ deliberation, reviews });
    expect(out.dissents).toHaveLength(2);
    for (const d of out.dissents) {
      // Empty (or absent) ts — persistence boundary owns wallclock.
      expect(d.ts === "" || d.ts === undefined).toBe(true);
    }

    // And calling synthesize twice yields identical dissents (no fresh ts).
    const out2 = synthesize({ deliberation, reviews });
    expect(out.dissents).toEqual(out2.dissents);
  });

  it("T7-FU-a: canonicalize emits identical bytes regardless of input key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ a: 1, b: { x: 1, y: 2 } })).toBe(
      canonicalize({ b: { y: 2, x: 1 }, a: 1 }),
    );
    // Arrays preserve their order (semantic), but nested object keys sort.
    expect(canonicalize([{ b: 2, a: 1 }, { d: 4, c: 3 }])).toBe(
      canonicalize([{ a: 1, b: 2 }, { c: 3, d: 4 }]),
    );
  });

  it("canonical JSON emits keys in alphabetical order at every level", () => {
    const value = {
      zeta: 1,
      alpha: { gamma: 3, beta: 2 },
      mike: [{ y: 1, x: 2 }, { b: 1, a: 2 }],
    };
    const out = canonicalize(value);
    // Top-level: alpha, mike, zeta
    expect(out.indexOf('"alpha"')).toBeLessThan(out.indexOf('"mike"'));
    expect(out.indexOf('"mike"')).toBeLessThan(out.indexOf('"zeta"'));
    // Nested object: beta < gamma
    expect(out.indexOf('"beta"')).toBeLessThan(out.indexOf('"gamma"'));
    // Array element keys sorted: a < b, x < y
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    expect(out.indexOf('"x"')).toBeLessThan(out.indexOf('"y"'));
    // Round-trips back to the same value structurally.
    expect(JSON.parse(out)).toEqual(value);
  });

  it("custom opts.similarityThreshold is honored", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationale: "- must fix authentication bug",
      }),
      makeReview({
        voterId: "v2",
        bit: "CHANGES",
        rationale: "- there's a bug in the deployment script",
      }),
    ];
    // Default threshold (0.45): "bug" overlap is too thin → unique each.
    const loose = synthesize({ deliberation, reviews }, { similarityThreshold: 0.05 });
    expect(loose.report.findings.some((f) => f.category === "consensus")).toBe(true);

    const strict = synthesize({ deliberation, reviews }, { similarityThreshold: 0.95 });
    expect(strict.report.findings.every((f) => f.category !== "consensus")).toBe(true);
    expect(strict.report.findings).toHaveLength(2);
  });

  it("custom opts.severityHeuristic overrides default classification", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({
        voterId: "v1",
        bit: "CHANGES",
        rationale: "- something benign here",
      }),
    ];
    const opts: SynthesizeOptions = {
      severityHeuristic: () => "CRITICAL",
    };
    const out = synthesize({ deliberation, reviews }, opts);
    expect(out.report.findings).toHaveLength(1);
    expect(out.report.findings[0].severity).toBe("CRITICAL");
  });

  it("reportHash is a sha256:<64-hex> matching the canonical bytes", () => {
    const deliberation = makeDeliberation();
    const reviews: VoterReview[] = [
      makeReview({ voterId: "v1", bit: "APPROVE", rationale: "fine" }),
    ];
    const out = synthesize({ deliberation, reviews });
    expect(out.reportHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // The canonical bytes are JSON-parseable and contain expected keys.
    // T7-FU-a: `ts` is intentionally absent from the hashed bytes.
    const parsed = JSON.parse(out.reportBytes);
    expect(parsed).toHaveProperty("findings");
    expect(parsed).toHaveProperty("tally");
    expect(parsed).toHaveProperty("dissentVoterIds");
    expect(parsed).not.toHaveProperty("ts");
    // The full returned report still carries `ts` for consumer visibility.
    expect(out.report).toHaveProperty("ts");
  });

  it("only reviews matching deliberation.currentRound are considered", () => {
    const deliberation = makeDeliberation({ currentRound: 2 });
    const reviews: VoterReview[] = [
      makeReview({ voterId: "v1", round: 1, bit: "CHANGES", rationale: "- old must-fix from round 1" }),
      makeReview({ voterId: "v2", round: 2, bit: "APPROVE", rationale: "round 2 ship it" }),
    ];
    const out = synthesize({ deliberation, reviews });
    expect(out.report.tally).toEqual({ approve: 1, changes: 0 });
    expect(out.dissents).toHaveLength(0);
    // Findings should only come from round 2's review.
    for (const f of out.report.findings) {
      expect(f.sourceVoterIds).not.toContain("v1");
    }
  });
});
