// Spawn / runtime error classification — a dependency-free leaf module so it
// can be shared by both probe-agent.ts and lifecycle.ts without re-introducing
// the probe-agent → lifecycle import cycle.
//
// Classifies an error message (or a child's captured stderr/output) into a
// typed retry-policy bucket:
//   - TRANSIENT (rate_limit / transport / overload) → retry with backoff
//   - STRUCTURAL (auth / quota / misconfig / validation) → escalate, no retry
//
// Heuristic on err.message + err.code — real-world error shapes vary across
// SDKs, so we match common substrings rather than exact codes. Anything
// unrecognized falls through to "spawn" (legacy bucket) so the contract is
// strictly additive: no message previously bucketed as "spawn" silently
// retargets unless it actually matches a more-specific pattern.

import type { ProbeFailureKind } from "../events/deliberation-events";

export type { ProbeFailureKind } from "../events/deliberation-events";

function errToString(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const anyErr = err as any;
    const parts: string[] = [];
    if (typeof anyErr.code === "string") parts.push(anyErr.code);
    if (typeof anyErr.message === "string") parts.push(anyErr.message);
    if (parts.length === 0) parts.push(String(err));
    return parts.join(" ");
  }
  return String(err);
}

// Classify a spawn-path / runtime error message into a typed bucket.
//
// Caveat: the heuristics are intentionally generous (e.g. "401" matches but so
// does "/v1/401-handler" — false-positive risk). If a real failure mis-buckets,
// tighten the regex here. Exported for unit testing.
export function classifySpawnError(err: unknown): ProbeFailureKind {
  const msg = errToString(err);
  if (!msg) return "spawn";

  // Order matters: match the most specific buckets first. Auth before
  // transport so "TLS 401 cert error" buckets to auth (the gateway rejected
  // creds), not transport.
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid[\s._-]*token/i.test(msg)) {
    return "auth";
  }
  // 429 rate-limit AND 529 "Overloaded" (Anthropic's transient capacity
  // signal) both bucket as rate_limit — both are retryable backpressure, not
  // a structural fault. Keeping them in one bucket means the retry policy
  // treats an overloaded API the same as a rate-limited one.
  if (/\b429\b|\b529\b|rate[\s._-]*limit|too[\s._-]*many[\s._-]*requests?|overloaded/i.test(msg)) {
    return "rate_limit";
  }
  if (/\b402\b|payment[\s._-]*required|quota|exhausted|usage[\s._-]*limit/i.test(msg)) {
    return "quota";
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS|certificate|SSL/i.test(msg)) {
    return "transport";
  }
  // Process-level: ENOENT (binary not found), EACCES (perm-denied on binary).
  // Fall through to "spawn" anyway so the legacy bucket holds the line.
  return "spawn";
}

// Retry policy: which buckets are worth re-spawning with backoff.
//
// rate_limit (incl. 429/529 overload) and transport (network/DNS/TLS blips)
// are transient — the same prompt may succeed on a later attempt. auth, quota,
// misconfig and validation are STRUCTURAL: the same prompt will fail
// identically until a human fixes credentials/billing/config, so retrying just
// burns time and budget. "spawn" (unknown) is deliberately NOT retried — we
// don't auto-retry failures we can't explain.
const TRANSIENT_KINDS: ReadonlySet<ProbeFailureKind> = new Set<ProbeFailureKind>([
  "rate_limit",
  "transport",
]);

export function isTransientFailure(kind: ProbeFailureKind): boolean {
  return TRANSIENT_KINDS.has(kind);
}
