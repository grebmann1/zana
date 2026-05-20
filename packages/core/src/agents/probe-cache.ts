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
// Caching policy (lives in manager.ts; see probeAgent integration):
//   ok=true                                                  → CACHE
//   ok=false / kind in {auth, misconfig}                     → CACHE  (structural; won't fix on retry)
//   ok=false / kind in {timeout, rate_limit, transport, quota} → SKIP cache (transient)
//   ok=false / kind in {validation, spawn}                   → CACHE  (legacy/ambiguous; safer to cache than spawn 9x in one round)

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

/**
 * Returns the cached ProbeResult if present AND younger than ttlMs.
 * Stale entries are NOT evicted on lookup — they are simply ignored. The next
 * recordProbeResult() with the same key will overwrite. Bounded staleness is
 * acceptable: ttlMs caps how long a stale entry can mislead a consumer.
 *
 * Increments `misses` when null is returned, `hits` otherwise. Both counters
 * are surfaced via getProbeCacheStats() for observability.
 */
export function lookupProbeResult(key: string, ttlMs: number): ProbeResult | null {
  if (!ttlMs || ttlMs <= 0) {
    misses++;
    return null;
  }
  const entry = cache.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  if (Date.now() - entry.cachedAt > ttlMs) {
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
