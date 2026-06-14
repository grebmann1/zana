import { describe, it, expect } from "vitest";
import { resolveVoters } from "@zana-ai/work/src/deliberation/role-packs.ts";

// ─────────────────────────────────────────────────────────────────────────────
// role-packs — returned-array isolation / replay-determinism guard.
//
// resolveVoters returns `ladder.slice(0, clamped)`, i.e. a FRESH array backed
// by the module-private ladder. The module contract is "same input always
// yields the same output (deterministic for replay)". That guarantee silently
// breaks if a caller mutates the returned array AND the implementation ever
// hands back the shared ladder reference (e.g. `return ladder` instead of a
// slice). These assertions lock the isolation in so such a regression fails
// loudly. Pure logic — no I/O, no real Claude.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveVoters — returned-array isolation", () => {
  it("returns a fresh array on each call (not the same reference)", () => {
    const a = resolveVoters("arch", 3);
    const b = resolveVoters("arch", 3);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("mutating a returned voter list does not corrupt subsequent calls", () => {
    const first = resolveVoters("arch", 3);
    first.push("attacker-injected-seat");
    first[0] = "tampered";

    const second = resolveVoters("arch", 3);
    expect(second).toEqual([
      "security-reviewer",
      "performance-engineer",
      "researcher",
    ]);
  });

  it("a clamped (full-depth) result is also an isolated copy", () => {
    const full = resolveVoters("review", 999);
    expect(full).toHaveLength(5);
    full.length = 0; // truncate the caller's copy

    const again = resolveVoters("review", 999);
    expect(again).toHaveLength(5);
    expect(again[0]).toBe("researcher");
  });
});
