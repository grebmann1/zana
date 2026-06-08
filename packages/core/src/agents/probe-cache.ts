// T6-FU-2 — probe-result cache, keyed by (profileId + ":" + modelId).
//
// Without this cache, T6 anti-dropout-bias replays runProbes() for every voter
// on every (re)assembly — worst case MAX_STALE_RETRIES × N voters × 3 legs per
// round, multiplied by deliberation rounds. Each probe spawns a real Claude
// child process: visible latency + rate-limit pain. Health changes slowly, so
// memoizing the (profileId, modelId) → ProbeResult tuple for a few minutes
// removes the redundant spawns without sacrificing freshness.
//
// Scope: process-lifetime, in-memory. Cross-process caching is YAGNI — daemon
// restart is a natural cache flush which is fine for v1.
//
// Caching policy (lives in probe-agent.ts; see probeAgent integration):
//   ok=true                                                  → CACHE @ regular TTL
//   ok=false / kind in {auth, misconfig, validation, spawn}  → CACHE @ regular TTL (structural / ambiguous)
//   ok=false / kind in {timeout, rate_limit, transport, quota} → CACHE @ transient TTL (short, dampens bursts)
//
// Per-kind TTL is enforced at lookup time: callers pass
// { regularTtlMs, transientTtlMs } and lookupProbeResult picks the right
// budget based on the cached result's failure kind. Stale-by-this-budget
// entries are returned as null (no eviction; the next record overwrites).

import type { ProbeResult } from "./manager";

interface CacheEntry {
  result: ProbeResult;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

let hits = 0;
let misses = 0;

export function recordProbeResult(key: string, result: ProbeResult): void {
  cache.set(key, { result, cachedAt: Date.now() });
}

// Transient failure kinds get a separate (shorter) TTL when looking up.
// Keep in sync with the caching-policy comment at the top of this file.
const TRANSIENT_KINDS = new Set(["timeout", "rate_limit", "transport", "quota"]);

function effectiveTtl(
  result: ProbeResult,
  ttl: number | { regularTtlMs: number; transientTtlMs: number },
): number {
  if (typeof ttl === "number") return ttl;
  if (result.ok) return ttl.regularTtlMs;
  // For mixed-kind failures, the most permissive choice wins — but we only
  // downgrade to transient when EVERY failure is transient. A single
  // structural failure keeps the entry on the regular budget (it's
  // structural; won't self-heal). This mirrors _shouldCacheProbeResult's
  // "all-or-nothing" predicate semantics.
  const allTransient = result.failures.length > 0
    && result.failures.every((f) => TRANSIENT_KINDS.has(f.kind));
  return allTransient ? ttl.transientTtlMs : ttl.regularTtlMs;
}

/**
 * Returns the cached ProbeResult if present AND younger than the resolved TTL.
 * Stale entries are NOT evicted on lookup — they are simply ignored. The next
 * recordProbeResult() with the same key will overwrite. Bounded staleness is
 * acceptable: TTL caps how long a stale entry can mislead a consumer.
 *
 * `ttl` is either a single ms value (legacy / kind-agnostic) or
 * { regularTtlMs, transientTtlMs } so callers can apply a shorter budget to
 * transient failures (timeout/rate_limit/transport/quota).
 *
 * Increments `misses` when null is returned, `hits` otherwise. Both counters
 * are surfaced via getProbeCacheStats() for observability.
 */
export function lookupProbeResult(
  key: string,
  ttl: number | { regularTtlMs: number; transientTtlMs: number },
): ProbeResult | null {
  if (typeof ttl === "number" ? (!ttl || ttl <= 0) : (ttl.regularTtlMs <= 0 && ttl.transientTtlMs <= 0)) {
    misses++;
    return null;
  }
  const entry = cache.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  const effective = effectiveTtl(entry.result, ttl);
  if (effective <= 0 || Date.now() - entry.cachedAt > effective) {
    misses++;
    return null;
  }
  hits++;
  return entry.result;
}

export function clearProbeCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

export function getProbeCacheStats(): { size: number; hits: number; misses: number } {
  return { size: cache.size, hits, misses };
}
