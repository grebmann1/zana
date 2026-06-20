// Focused coverage for effectiveTtl's all-transient path with MORE THAN ONE
// failure. probe-cache.ts selects the short transient budget only when
// `result.failures.every(f => TRANSIENT_KINDS.has(f.kind))` — i.e. EVERY
// failure is transient. The sibling probe-cache.test.ts exercises that
// predicate with a single transient failure (every → true) and with a mixed
// transient+structural result (every → false), but never a multi-element
// result whose failures are ALL transient. A regression that inspected only
// `failures[0].kind` instead of iterating with `.every()` would pass both of
// those cases while still applying the transient budget here — this pins that
// the predicate genuinely spans every element, and that a single structural
// failure anywhere in a multi-element list flips it back to the regular budget.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordProbeResult,
  lookupProbeResult,
  clearProbeCache,
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

describe("probe-cache — effectiveTtl all-transient with multiple failures", () => {
  beforeEach(() => {
    clearProbeCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearProbeCache();
  });

  const TTL = { regularTtlMs: 5 * 60 * 1000, transientTtlMs: 30_000 };

  it("uses transientTtlMs when ALL of several failures are transient kinds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    // Three distinct transient kinds — none structural.
    const allTransient = fakeResult({
      ok: false,
      failures: [
        { leg: "factual", kind: "timeout", reason: "slow" } as any,
        { leg: "instructionFollowing", kind: "rate_limit", reason: "429" } as any,
        { leg: "factual", kind: "transport", reason: "ECONNRESET" } as any,
      ],
    });
    recordProbeResult("profA:modX", allTransient);

    // Within the 30s transient budget → hit.
    vi.setSystemTime(new Date("2026-01-01T00:00:20Z"));
    expect(lookupProbeResult("profA:modX", TTL)).not.toBeNull();

    // Past the transient budget but well within the 5m regular budget. If the
    // predicate truly spans every element, the short transient budget applies
    // and this is now stale → miss.
    vi.setSystemTime(new Date("2026-01-01T00:00:35Z"));
    expect(lookupProbeResult("profA:modX", TTL)).toBeNull();
  });

  it("a single structural failure among many transient ones flips back to regularTtlMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    // All transient except one structural (auth) in the middle.
    const oneStructural = fakeResult({
      ok: false,
      failures: [
        { leg: "factual", kind: "timeout", reason: "slow" } as any,
        { leg: "instructionFollowing", kind: "auth", reason: "401" } as any,
        { leg: "factual", kind: "transport", reason: "ECONNRESET" } as any,
      ],
    });
    recordProbeResult("profA:modX", oneStructural);

    // Past the transient budget but within the regular budget. A single
    // structural failure must keep the entry on the regular (5m) budget → hit.
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(lookupProbeResult("profA:modX", TTL)).not.toBeNull();
  });
});
