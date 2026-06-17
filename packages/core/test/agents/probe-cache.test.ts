import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordProbeResult,
  lookupProbeResult,
  clearProbeCache,
  getProbeCacheStats,
} from "@zana-ai/core/src/agents/probe-cache.ts";
import type { ProbeResult } from "@zana-ai/core/src/agents/manager.ts";

function fakeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    ok: true,
    latencyMs: 42,
    failures: [],
    modelId: "claude-sonnet-4-7",
    probeId: "probe-1",
    legs: [],
    cached: false,
    ...overrides,
  };
}

describe("probe-cache (T6-FU-2)", () => {
  beforeEach(() => {
    clearProbeCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearProbeCache();
  });

  it("lookupProbeResult returns null on missing key", () => {
    expect(lookupProbeResult("missing-key", 60_000)).toBeNull();
  });

  it("recordProbeResult + lookupProbeResult round-trip", () => {
    const result = fakeResult({ probeId: "p1" });
    recordProbeResult("profA:modX", result);
    const found = lookupProbeResult("profA:modX", 60_000);
    expect(found).not.toBeNull();
    expect(found!.probeId).toBe("p1");
    expect(found!.modelId).toBe("claude-sonnet-4-7");
  });

  it("lookupProbeResult returns null when ttl exceeded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordProbeResult("profA:modX", fakeResult());
    // Advance past ttl.
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z").getTime() + 1);
    const found = lookupProbeResult("profA:modX", 5 * 60 * 1000);
    expect(found).toBeNull();
  });

  it("lookupProbeResult returns the entry when within ttl", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordProbeResult("profA:modX", fakeResult({ probeId: "still-fresh" }));
    vi.setSystemTime(new Date("2026-01-01T00:04:59Z"));
    const found = lookupProbeResult("profA:modX", 5 * 60 * 1000);
    expect(found).not.toBeNull();
    expect(found!.probeId).toBe("still-fresh");
  });

  it("lookupProbeResult with ttlMs=0 always returns null (cache disabled)", () => {
    recordProbeResult("profA:modX", fakeResult());
    expect(lookupProbeResult("profA:modX", 0)).toBeNull();
  });

  it("clearProbeCache empties everything (and resets stats)", () => {
    recordProbeResult("profA:modX", fakeResult());
    recordProbeResult("profB:modY", fakeResult());
    expect(getProbeCacheStats().size).toBe(2);
    // Generate a hit so counters are non-zero.
    lookupProbeResult("profA:modX", 60_000);
    expect(getProbeCacheStats().hits).toBeGreaterThan(0);

    clearProbeCache();
    const stats = getProbeCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it("cache stats track hits + misses", () => {
    recordProbeResult("profA:modX", fakeResult());

    // 2 hits
    lookupProbeResult("profA:modX", 60_000);
    lookupProbeResult("profA:modX", 60_000);
    // 3 misses (different key, ttl=0, ttl-stale)
    lookupProbeResult("does-not-exist", 60_000);
    lookupProbeResult("profA:modX", 0);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    lookupProbeResult("profA:modX", 60_000);

    const stats = getProbeCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(3);
  });

  it("recordProbeResult overwrites stale entries on the same key", () => {
    recordProbeResult("profA:modX", fakeResult({ probeId: "v1" }));
    recordProbeResult("profA:modX", fakeResult({ probeId: "v2" }));
    expect(getProbeCacheStats().size).toBe(1);
    const found = lookupProbeResult("profA:modX", 60_000);
    expect(found!.probeId).toBe("v2");
  });

  // The freshness check is `Date.now() - cachedAt > effective` — a STRICT
  // greater-than, so an entry whose age is EXACTLY the TTL is still fresh
  // (age > ttl is false → served). The existing suite brackets this edge with
  // 4:59 (hit) and 5:00+1ms (miss) but never lands on the boundary itself.
  // Pins the strict-`>` contract against a `>=` regression that would expire
  // entries one tick early.
  it("serves an entry whose age is EXACTLY the ttl (strict-greater boundary)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordProbeResult("profA:modX", fakeResult({ probeId: "on-the-boundary" }));
    // Advance by exactly the TTL: elapsed === effective → age > ttl is false.
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + 5 * 60 * 1000);
    const found = lookupProbeResult("profA:modX", 5 * 60 * 1000);
    expect(found).not.toBeNull();
    expect(found!.probeId).toBe("on-the-boundary");
    // One ms past the boundary → miss, confirming the boundary is the last
    // fresh instant rather than the first stale one.
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z").getTime() + 5 * 60 * 1000 + 1);
    expect(lookupProbeResult("profA:modX", 5 * 60 * 1000)).toBeNull();
  });

  // The legacy single-number `ttl` form is kind-agnostic: effectiveTtl returns
  // it verbatim (`if (typeof ttl === "number") return ttl`) WITHOUT consulting
  // the failure kind. So a transient (timeout) failure recorded and looked up
  // with a plain number budget must stay a HIT for the full number window —
  // it must NOT be expired early on a transient budget. Every existing
  // number-form test records an ok=true result, leaving this transient-failure
  // + number-form arm unexercised; pins the legacy contract against a
  // regression that routes the number form through the per-kind transient path.
  it("number-form ttl is kind-agnostic: a transient failure uses the full number window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const transientResult = fakeResult({
      ok: false,
      failures: [{ leg: "factual", kind: "timeout", reason: "slow" } as any],
    });
    recordProbeResult("profA:modX", transientResult);

    // 60s in — well past any transient (30s) budget, but the number form has no
    // transient budget, so the full 5-minute window applies → still a HIT.
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    const found = lookupProbeResult("profA:modX", 5 * 60 * 1000);
    expect(found).not.toBeNull();
    expect(found!.failures[0].kind).toBe("timeout");

    // Past the number window → miss.
    vi.setSystemTime(new Date("2026-01-01T00:06:00Z").getTime() + 1);
    expect(lookupProbeResult("profA:modX", 5 * 60 * 1000)).toBeNull();
  });

  // ── Per-kind TTL (transient cache) ────────────────────────────────────────
  describe("per-kind TTL", () => {
    it("transient-failure cache uses transientTtlMs, expires earlier than regular", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const transientResult = fakeResult({
        ok: false,
        failures: [{ leg: "factual", kind: "timeout", reason: "x" } as any],
      });
      recordProbeResult("profA:modX", transientResult);

      // Within transientTtl (30s) → hit.
      vi.setSystemTime(new Date("2026-01-01T00:00:20Z"));
      let found = lookupProbeResult("profA:modX", { regularTtlMs: 5 * 60 * 1000, transientTtlMs: 30_000 });
      expect(found).not.toBeNull();

      // Past transientTtl but well within regularTtl → miss for transient kinds.
      vi.setSystemTime(new Date("2026-01-01T00:00:35Z"));
      found = lookupProbeResult("profA:modX", { regularTtlMs: 5 * 60 * 1000, transientTtlMs: 30_000 });
      expect(found).toBeNull();
    });

    it("structural-failure cache uses regularTtlMs even when transientTtl is short", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const structResult = fakeResult({
        ok: false,
        failures: [{ leg: null, kind: "auth", reason: "401" } as any],
      });
      recordProbeResult("profA:modX", structResult);

      // 1m past transient TTL — but kind=auth uses regularTtlMs.
      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      const found = lookupProbeResult("profA:modX", { regularTtlMs: 5 * 60 * 1000, transientTtlMs: 30_000 });
      expect(found).not.toBeNull();
    });

    it("ok=true entry uses regularTtlMs", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      recordProbeResult("profA:modX", fakeResult({ ok: true }));
      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      const found = lookupProbeResult("profA:modX", { regularTtlMs: 5 * 60 * 1000, transientTtlMs: 30_000 });
      expect(found).not.toBeNull();
    });

    it("mixed transient + structural failures use regularTtl (structural pins it)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const mixed = fakeResult({
        ok: false,
        failures: [
          { leg: "factual", kind: "timeout", reason: "x" } as any,
          { leg: "instructionFollowing", kind: "auth", reason: "y" } as any,
        ],
      });
      recordProbeResult("profA:modX", mixed);
      // Past transient budget, well within regular — should hit.
      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      const found = lookupProbeResult("profA:modX", { regularTtlMs: 5 * 60 * 1000, transientTtlMs: 30_000 });
      expect(found).not.toBeNull();
    });

    it("ok=false with empty failures falls back to regularTtlMs (length>0 guard)", () => {
      // Guards the `result.failures.length > 0` predicate in effectiveTtl:
      // `[].every(...)` is vacuously true, so dropping the guard would
      // misclassify an empty-failures result as all-transient and apply the
      // short TTL. With the guard, it must use the regular budget.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const emptyFailures = fakeResult({ ok: false, failures: [] });
      recordProbeResult("profA:modX", emptyFailures);

      // 1m in: past the transient budget (30s), well within regular (5m).
      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      const found = lookupProbeResult("profA:modX", { regularTtlMs: 5 * 60 * 1000, transientTtlMs: 30_000 });
      expect(found).not.toBeNull();
    });

    it("transientTtlMs=0 disables transient caching while keeping structural cache live", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const transientResult = fakeResult({
        ok: false,
        failures: [{ leg: "factual", kind: "timeout", reason: "x" } as any],
      });
      recordProbeResult("profA:modX", transientResult);
      // Even at t=0 — transient cache disabled means lookup returns null.
      const found = lookupProbeResult("profA:modX", { regularTtlMs: 5 * 60 * 1000, transientTtlMs: 0 });
      expect(found).toBeNull();
    });

    it("regularTtlMs=0 still serves a transient-failure entry via transientTtlMs", () => {
      // The top-level disabled-cache guard is asymmetric: it only short-circuits
      // when BOTH budgets are <= 0. So regularTtlMs=0 alone must NOT disable the
      // cache — for a transient failure, effectiveTtl() selects transientTtlMs,
      // so a fresh entry within that budget is a HIT. The existing suite covers
      // the inverse (transientTtlMs=0 + structural live) and both-zero, but never
      // this regular-off / transient-live arm for a transient kind.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const transientResult = fakeResult({
        ok: false,
        failures: [{ leg: "factual", kind: "rate_limit", reason: "429" } as any],
      });
      recordProbeResult("profA:modX", transientResult);

      // Within transientTtl (30s) → hit, despite regularTtlMs being 0.
      vi.setSystemTime(new Date("2026-01-01T00:00:20Z"));
      let found = lookupProbeResult("profA:modX", { regularTtlMs: 0, transientTtlMs: 30_000 });
      expect(found).not.toBeNull();
      expect(found!.failures[0].kind).toBe("rate_limit");

      // Past transientTtl → miss (regular budget can't rescue it; it's 0).
      vi.setSystemTime(new Date("2026-01-01T00:00:35Z"));
      found = lookupProbeResult("profA:modX", { regularTtlMs: 0, transientTtlMs: 30_000 });
      expect(found).toBeNull();
    });

    it("object-form ttl with BOTH budgets <= 0 disables the cache (early-return miss)", () => {
      // Guards the object-form arm of the top-level disabled-cache check in
      // lookupProbeResult: `ttl.regularTtlMs <= 0 && ttl.transientTtlMs <= 0`.
      // When BOTH budgets are non-positive the cache is fully off, so lookup
      // must short-circuit to null and count a miss — even for a just-recorded
      // fresh ok=true entry (no timers needed). The existing transientTtlMs=0
      // test keeps regularTtlMs live, so this both-zero arm is otherwise
      // unexercised.
      recordProbeResult("profA:modX", fakeResult({ probeId: "fresh" }));
      const before = getProbeCacheStats().misses;
      const found = lookupProbeResult("profA:modX", { regularTtlMs: 0, transientTtlMs: 0 });
      expect(found).toBeNull();
      expect(getProbeCacheStats().misses).toBe(before + 1);
    });

    it("regularTtlMs=0 disables caching for an ok=true entry even when transientTtlMs is positive", () => {
      // Complements "regularTtlMs=0 still serves a transient-failure entry":
      // for that arm effectiveTtl() picks the (positive) transientTtlMs, so the
      // transient entry is a HIT. Here the entry is ok=true, so effectiveTtl()
      // resolves to regularTtlMs=0. The top-level disabled-cache guard does NOT
      // trip (transientTtlMs is positive), so control reaches the PER-ENTRY
      // second guard `if (effective <= 0 || ...)` in lookupProbeResult — which
      // must short-circuit to a miss at t=0 (no timer advance needed). Pins that
      // a 0 regular budget disables the cache for ok/structural entries despite
      // a live transient budget — the asymmetric arm the suite leaves untested.
      recordProbeResult("profA:modX", fakeResult({ ok: true, probeId: "fresh-ok" }));
      const before = getProbeCacheStats().misses;
      const found = lookupProbeResult("profA:modX", { regularTtlMs: 0, transientTtlMs: 30_000 });
      expect(found).toBeNull();
      expect(getProbeCacheStats().misses).toBe(before + 1);
    });
  });
});
