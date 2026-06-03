// Tests for packages/intelligence/src/intelligence/vector-memory.ts
//
// The module holds module-level global state (entries, vocabulary, docFreqMap).
// We mock @zana-ai/core to avoid real-FS writes (ZANA_DIR) and isolate event
// bus calls. Fake timers suppress the 5-second save debounce so no actual
// disk I/O occurs during tests.
//
// Tests are additive — each uses content unique enough not to collide with
// others. The suite covers: store, search, get, stats, promote, and maintain
// (TTL expiry path via fake Date.now).

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// ── Hoist mocks before module imports ─────────────────────────────────────────

vi.mock("@zana-ai/core", () => ({
  config: { ZANA_DIR: "/tmp/zana-vector-memory-test" },
  events: {
    service: {
      emit: vi.fn(),
      subscribe: vi.fn(() => vi.fn()), // returns an unsubscribe fn
    },
  },
}));

// Import AFTER mocks are registered
import * as vm from "@zana-ai/intelligence/src/intelligence/vector-memory.ts";

// ── Suite setup ───────────────────────────────────────────────────────────────

beforeAll(() => {
  vi.useFakeTimers(); // suppress the 5-second debounce + maintain interval
});

afterAll(() => {
  vi.useRealTimers();
});

// ─── store() ─────────────────────────────────────────────────────────────────

describe("store()", () => {
  it("returns an object with id (UUID) and tier", () => {
    const result = vm.store({ content: "store-test unique phrase" });
    expect(result).toHaveProperty("id");
    expect(typeof result.id).toBe("string");
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.tier).toBe("episodic"); // default tier
  });

  it("respects an explicit tier", () => {
    const result = vm.store({
      content: "store-tier-test unique semantic phrase",
      tier: "semantic",
    });
    expect(result.tier).toBe("semantic");
  });

  it("stores metadata alongside the entry", () => {
    const { id } = vm.store({
      content: "store-metadata unique phrase with custom meta",
      metadata: { source: "test-suite", tags: ["unit"] },
    });
    const entry = vm.get(id)!;
    expect(entry.metadata.source).toBe("test-suite");
    expect(entry.metadata.tags).toEqual(["unit"]);
  });
});

// ─── get() ───────────────────────────────────────────────────────────────────

describe("get()", () => {
  it("retrieves a stored entry by id", () => {
    const { id } = vm.store({ content: "get-test unique phrase for retrieval" });
    const entry = vm.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(id);
    expect(entry!.content).toBe("get-test unique phrase for retrieval");
    expect(entry!.tier).toBe("episodic");
    expect(entry!.createdAt).toBeTypeOf("number");
  });

  it("returns null for an unknown id", () => {
    expect(vm.get("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

// ─── search() ────────────────────────────────────────────────────────────────

describe("search()", () => {
  it("returns results sorted by score descending", () => {
    vm.store({ content: "search-sort zebra striped animal africa unique" });
    vm.store({ content: "search-sort elephant large mammal africa unique" });
    const results = vm.search("search-sort africa unique");
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  });

  it("each result has id, content, score, tier, metadata fields", () => {
    vm.store({ content: "search-fields structured unique content phrase" });
    const results = vm.search("search-fields unique phrase");
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r).toHaveProperty("id");
    expect(r).toHaveProperty("content");
    expect(r).toHaveProperty("score");
    expect(r).toHaveProperty("tier");
    expect(r).toHaveProperty("metadata");
  });

  it("filters by tier when tier option is provided", () => {
    vm.store({ content: "tier-filter unique semantic word", tier: "semantic" });
    vm.store({ content: "tier-filter unique episodic word", tier: "episodic" });
    const semanticOnly = vm.search("tier-filter unique", { tier: "semantic" });
    for (const r of semanticOnly) {
      expect(r.tier).toBe("semantic");
    }
  });

  it("respects the limit option", () => {
    // Store several entries with overlapping terms
    for (let i = 0; i < 5; i++) {
      vm.store({ content: `limit-test unique phrase number ${i}` });
    }
    const results = vm.search("limit-test unique phrase", { limit: 2, minScore: 0 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("scores stored entries higher than unrelated noise", () => {
    vm.store({ content: "cosine-relevance python programming language coding" });
    vm.store({ content: "cosine-noise unrelated random text furniture chair" });
    const results = vm.search("cosine-relevance python programming language");
    // The python entry should appear and rank first
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("python programming");
  });
});

// ─── stats() ─────────────────────────────────────────────────────────────────

describe("stats()", () => {
  it("returns total, byTier, and vocabularySize", () => {
    const s = vm.stats();
    expect(s).toHaveProperty("total");
    expect(s).toHaveProperty("byTier");
    expect(s).toHaveProperty("vocabularySize");
    expect(typeof s.total).toBe("number");
    expect(s.total).toBeGreaterThan(0); // entries accumulated from earlier tests
  });
});

// ─── promote() ───────────────────────────────────────────────────────────────

describe("promote()", () => {
  it("changes the tier of an existing entry", () => {
    const { id } = vm.store({ content: "promote-test unique phrase to change tier" });
    const before = vm.get(id)!;
    expect(before.tier).toBe("episodic");
    const ok = vm.promote(id, "semantic");
    expect(ok).toBe(true);
    const after = vm.get(id)!;
    expect(after.tier).toBe("semantic");
  });

  it("returns false for an unknown id", () => {
    expect(vm.promote("00000000-0000-0000-0000-000000000001", "semantic")).toBe(false);
  });
});

// ─── maintain() — TTL expiry ──────────────────────────────────────────────────

describe("maintain()", () => {
  it("expires working-tier entries older than 1 hour", () => {
    // Store a working-tier entry backdated by 2 hours
    const { id } = vm.store({
      content: "maintain-expire unique working entry",
      tier: "working",
    });

    // Manually backdate the entry so it looks 2-hour old
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    vi.setSystemTime(Date.now() + TWO_HOURS);

    const statsBefore = vm.stats();
    const result = vm.maintain();
    const statsAfter = vm.stats();

    // The entry we backdated should now be expired
    expect(result.expired).toBeGreaterThan(0);
    expect(statsAfter.total).toBeLessThan(statsBefore.total);
    expect(vm.get(id)).toBeNull();

    // Restore time
    vi.setSystemTime(new Date());
  });

  it("returns { expired, consolidated } shape", () => {
    const result = vm.maintain();
    expect(result).toHaveProperty("expired");
    expect(result).toHaveProperty("consolidated");
  });
});
