// Deliberation synthesis reducer — T7
//
// Pure-ish reducer that takes a Deliberation + the typed reviews for the
// current round and produces a structured SynthesisReport. The report is
// canonically serialized (alphabetical key order) so the same input always
// hashes to the same content-addressed digest. The caller (T9 MCP wiring)
// is responsible for:
//   - calling transition(SYNTHESIZING, { synthesisHash })
//   - calling recordDissent() for each returned Dissent
//
// This reducer is rule-based for Sprint 2 (no LLM): it splits each voter's
// rationale into bullet candidates, infers a severity per candidate, then
// fuzzy-groups candidates across voters using Dice coefficient on word sets.
// A voter who voted CHANGES is also recorded as dissent verbatim — the
// governance bar requires the minority report to be preserved, never
// collapsed into consensus.
//
// Side effects: storeContentAddressed() writes the canonical JSON bytes to
// the artifact store. No state machine mutations, no event emission.

import * as artifactStore from "../runs/artifact-store";
import { getRuntimeConfig } from "./runtime-config";

import type {
  Deliberation,
  Dissent,
  SynthesisFinding,
  SynthesisReport,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────────

export interface VoterReview {
  voterId: string;
  profileId: string;
  modelId: string;
  round: number;
  bit: "APPROVE" | "CHANGES";
  rationaleHash: string;
  // Raw rationale text — the synthesizer reads this to extract findings.
  rationale: string;
}

export interface SynthesisInput {
  deliberation: Deliberation;
  reviews: VoterReview[]; // all reviews for the current round
}

export type Severity = "CRITICAL" | "MAJOR" | "MINOR" | "NIT";

export interface SynthesizeOptions {
  // Fuzzy-group threshold for cross-voter consensus detection. 0..1; default 0.45.
  similarityThreshold?: number;
  // Override the default keyword-based severity classifier.
  severityHeuristic?: (text: string) => Severity;
}

export interface SynthesisOutput {
  report: SynthesisReport;
  // Canonical JSON serialization (deterministic alphabetical key order),
  // EXCLUDING `report.ts` — these are the exact bytes hashed into reportHash.
  // (T7-FU-a) The full `report` object carries `ts` for consumer visibility,
  // but the hashable projection drops it so identical input → identical hash.
  reportBytes: string;
  reportHash: string;  // sha256:<hex> over reportBytes
  dissents: Dissent[]; // verbatim — caller appends via recordDissent
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity heuristic
// ─────────────────────────────────────────────────────────────────────────────

const CRITICAL_KEYWORDS = ["blocker", "critical", "must", "security", "vulnerab", "exploit", "csrf", "xss", "injection"];
const MAJOR_KEYWORDS = ["should", "important", "missing", "broken", "regression", "incorrect"];
const MINOR_KEYWORDS = ["consider", "could", "minor", "nice", "prefer"];

function defaultSeverityHeuristic(text: string): Severity {
  const t = text.toLowerCase();
  for (const k of CRITICAL_KEYWORDS) {
    if (t.includes(k)) return "CRITICAL";
  }
  for (const k of MAJOR_KEYWORDS) {
    if (t.includes(k)) return "MAJOR";
  }
  for (const k of MINOR_KEYWORDS) {
    if (t.includes(k)) return "MINOR";
  }
  return "NIT";
}

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 3,
  MAJOR: 2,
  MINOR: 1,
  NIT: 0,
};

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bullet extraction
//
// We accept three shapes per rationale:
//   - explicit list markers: lines starting with "-", "*", "•", or "N." / "N)"
//   - sentence-terminated text: split on ". ", "! ", "? "
//   - falls back to the whole trimmed rationale as one finding
// Empty / whitespace-only candidates are dropped.
// ─────────────────────────────────────────────────────────────────────────────

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

function extractBullets(rationale: string): string[] {
  if (typeof rationale !== "string") return [];
  const trimmed = rationale.trim();
  if (trimmed === "") return [];

  const lines = trimmed.split(/\r?\n/);
  const bulletLines = lines.filter((l) => BULLET_RE.test(l));

  if (bulletLines.length > 0) {
    return bulletLines
      .map((l) => l.replace(BULLET_RE, "").trim())
      .filter((s) => s.length > 0);
  }

  // No bullet markers — split on sentence terminators.
  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().replace(/[.!?]+$/, "").trim())
    .filter((s) => s.length > 0);

  return sentences.length > 0 ? sentences : [trimmed];
}

// ─────────────────────────────────────────────────────────────────────────────
// Similarity (Dice coefficient on word sets)
// ─────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "and", "or", "the", "is", "are", "be", "to", "of", "in", "on",
  "for", "with", "this", "that", "it", "as", "at", "by", "we", "you", "i",
  "but", "not", "no", "so", "if", "do", "does", "did",
]);

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return (2 * inter) / (a.size + b.size);
}

// ─────────────────────────────────────────────────────────────────────────────
// Negation detection (heuristic for disagreement)
//
// If two findings group together but ONE has negation/refutation markers and
// the other doesn't, classify as disagreement instead of consensus.
// ─────────────────────────────────────────────────────────────────────────────

const NEGATION_RE = /\b(not|no need|wrong|fine|disagree|isn't|isnt|doesn't|doesnt|don't|dont|incorrect|n't)\b/i;

function isNegated(text: string): boolean {
  return NEGATION_RE.test(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical JSON
//
// Stable, deterministic serialization: object keys are emitted in
// alphabetical order at every level. Arrays preserve order.
// ─────────────────────────────────────────────────────────────────────────────

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => canonicalValue(v));
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = canonicalValue(obj[k]);
  }
  return sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tally
//
// computeTallyForRound is private to run.ts; replicate the trivial logic here
// rather than refactoring run.ts.
// ─────────────────────────────────────────────────────────────────────────────

function computeTally(reviews: VoterReview[], round: number): { approve: number; changes: number } {
  const tally = { approve: 0, changes: 0 };
  for (const r of reviews) {
    if (r.round !== round) continue;
    if (r.bit === "APPROVE") tally.approve++;
    else if (r.bit === "CHANGES") tally.changes++;
  }
  return tally;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

interface Candidate {
  voterId: string;
  text: string;
  tokens: Set<string>;
  severity: Severity;
  negated: boolean;
}

export function synthesize(input: SynthesisInput, opts?: SynthesizeOptions): SynthesisOutput {
  if (!input || typeof input !== "object") {
    throw new Error("synthesize: input is required");
  }
  if (!input.deliberation || typeof input.deliberation !== "object") {
    throw new Error("synthesize: input.deliberation is required");
  }
  if (!Array.isArray(input.reviews)) {
    throw new Error("synthesize: input.reviews must be an array");
  }

  const configuredThreshold = (() => {
    const v = getRuntimeConfig().synthesisSimilarityThreshold;
    return typeof v === "number" && v >= 0 && v <= 1 ? v : 0.45;
  })();
  const threshold =
    typeof opts?.similarityThreshold === "number" && opts.similarityThreshold >= 0 && opts.similarityThreshold <= 1
      ? opts.similarityThreshold
      : configuredThreshold;
  const severityFn: (text: string) => Severity =
    typeof opts?.severityHeuristic === "function" ? opts.severityHeuristic : defaultSeverityHeuristic;

  const round = input.deliberation.currentRound;
  const roundReviews = input.reviews.filter((r) => r.round === round);

  // 1. Extract finding candidates per review.
  const candidates: Candidate[] = [];
  for (const r of roundReviews) {
    const bullets = extractBullets(r.rationale);
    for (const b of bullets) {
      candidates.push({
        voterId: r.voterId,
        text: b,
        tokens: tokenize(b),
        severity: severityFn(b),
        negated: isNegated(b),
      });
    }
  }

  // 2. Group candidates across voters by Dice similarity.
  // We seed groups greedily in input order — for a given candidate, find the
  // first existing group whose representative passes the threshold. Same-voter
  // candidates are NEVER grouped (consensus must span >=2 voters).
  const groups: Candidate[][] = [];
  for (const c of candidates) {
    let placed = false;
    for (const g of groups) {
      if (g.some((m) => m.voterId === c.voterId)) continue; // same-voter dup → keep separate
      const sim = Math.max(...g.map((m) => dice(c.tokens, m.tokens)));
      if (sim >= threshold) {
        g.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([c]);
  }

  // 3. Categorize each group → SynthesisFinding.
  const findings: SynthesisFinding[] = [];
  for (const g of groups) {
    const sourceVoterIds = Array.from(new Set(g.map((m) => m.voterId)));
    const severity = g.reduce<Severity>((acc, m) => maxSeverity(acc, m.severity), g[0].severity);
    // Use the first member's text as the canonical phrasing — deterministic
    // because group order follows input order.
    const text = g[0].text;

    let category: SynthesisFinding["category"];
    if (g.length >= 2) {
      const negCount = g.filter((m) => m.negated).length;
      if (negCount > 0 && negCount < g.length) {
        category = "disagreement";
      } else {
        category = "consensus";
      }
    } else {
      category = "unique";
    }

    findings.push({ severity, text, sourceVoterIds, category });
  }

  // 4. Tally.
  const tally = computeTally(roundReviews, round);

  // 5. Dissent — every CHANGES voter, verbatim. We synthesize one Dissent per
  // CHANGES review; if a voter has multiple reviews in this round (shouldn't
  // happen but guard anyway), record the latest one.
  //
  // T7-FU-a: do NOT stamp `ts` here. Persistence boundary (recordDissent in
  // run.ts) is responsible for stamping the canonical `ts` so the in-memory
  // value the synthesizer returns is deterministic for replay/dedup.
  const dissentByVoter = new Map<string, Dissent>();
  for (const r of roundReviews) {
    if (r.bit !== "CHANGES") continue;
    dissentByVoter.set(r.voterId, {
      voterId: r.voterId,
      profileId: r.profileId,
      round: r.round,
      rationaleHash: r.rationaleHash,
      ts: "",
    });
  }
  const dissents = Array.from(dissentByVoter.values());

  // 6. Build the report. The full report carries `ts` so consumers can see
  // when synthesis happened, but the hashed bytes MUST NOT contain `ts` —
  // otherwise two calls with identical input produce different reportHash
  // and the T1 synthesisHash audit-replay invariant breaks (T7-FU-a).
  const report: SynthesisReport = {
    findings,
    tally,
    dissentVoterIds: dissents.map((d) => d.voterId),
    ts: new Date().toISOString(),
  };

  // 7. Canonical serialization + content-addressed hash.
  // Hash a ts-less projection of the report. The bytes that land in CAS are
  // the canonical, ts-less form — single source of truth for replay. The
  // full report (with ts) lives in memory only and is returned alongside.
  const { ts: _ts, ...hashableReport } = report;
  void _ts;
  const reportBytes = canonicalize(hashableReport);
  const stored = artifactStore.storeContentAddressed(reportBytes);
  const reportHash = stored.hash;

  return { report, reportBytes, reportHash, dissents };
}
