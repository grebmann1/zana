import { describe, it, expect } from "vitest";
import {
  listRolePacks,
  getRolePack,
  resolveVoters,
  normalizeVotersInput,
} from "@zana-ai/work/src/deliberation/role-packs.ts";

// ─────────────────────────────────────────────────────────────────────────────
// role-packs — pure-logic, no I/O, no real Claude.
// ─────────────────────────────────────────────────────────────────────────────

describe("listRolePacks", () => {
  it("returns all four named packs", () => {
    const packs = listRolePacks();
    const ids = packs.map((p) => p.id).sort();
    expect(ids).toEqual(["arch", "code-review", "plan", "review"]);
  });

  it("every pack entry has id and description", () => {
    for (const pack of listRolePacks()) {
      expect(typeof pack.id).toBe("string");
      expect(pack.id.length).toBeGreaterThan(0);
      expect(typeof pack.description).toBe("string");
      expect(pack.description.length).toBeGreaterThan(0);
    }
  });
});

describe("getRolePack", () => {
  it("returns the correct spec for a known pack id", () => {
    const pack = getRolePack("arch");
    expect(pack).not.toBeNull();
    expect(pack!.id).toBe("arch");
  });

  it("returns null for an unknown id", () => {
    expect(getRolePack("nonexistent")).toBeNull();
  });

  it("returns null for a non-string argument", () => {
    // @ts-expect-error — deliberate wrong type
    expect(getRolePack(42)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(getRolePack("")).toBeNull();
  });
});

describe("resolveVoters", () => {
  it("returns first N entries of the arch ladder for quantity=3", () => {
    const voters = resolveVoters("arch", 3);
    expect(voters).toEqual(["security-reviewer", "performance-engineer", "researcher"]);
  });

  it("is deterministic — same input yields same output on repeated calls", () => {
    const a = resolveVoters("code-review", 2);
    const b = resolveVoters("code-review", 2);
    expect(a).toEqual(b);
  });

  it("clamps quantity to the ladder length when it exceeds it", () => {
    const voters = resolveVoters("arch", 999);
    expect(voters.length).toBe(5); // ARCH_LADDER has 5 entries
  });

  it("returns exactly 1 voter for quantity=1", () => {
    const voters = resolveVoters("review", 1);
    expect(voters).toHaveLength(1);
    expect(voters[0]).toBe("researcher"); // generalist-first in review pack
  });

  it("floors fractional quantity (e.g. 2.9 → 2)", () => {
    const voters = resolveVoters("plan", 2.9);
    expect(voters).toHaveLength(2);
  });

  it("throws for quantity < 1", () => {
    expect(() => resolveVoters("arch", 0)).toThrow(/quantity must be >= 1/);
  });

  it("throws for unknown pack id", () => {
    expect(() => resolveVoters("unknown-pack", 1)).toThrow(/unknown role pack/);
  });
});

describe("normalizeVotersInput", () => {
  const defaults = ["researcher", "code-reviewer"];

  it("returns the defaults when input is undefined", () => {
    expect(normalizeVotersInput(undefined, defaults)).toEqual(defaults);
  });

  it("returns a copy of defaults (not the same reference)", () => {
    const result = normalizeVotersInput(undefined, defaults);
    result.push("extra");
    expect(defaults).toHaveLength(2); // original unchanged
  });

  it("passes an explicit array through unchanged", () => {
    const input = ["security-reviewer", "architect"];
    expect(normalizeVotersInput(input, defaults)).toBe(input);
  });

  it("resolves a pack object with explicit quantity", () => {
    const result = normalizeVotersInput({ pack: "arch", quantity: 2 }, defaults);
    expect(result).toEqual(["security-reviewer", "performance-engineer"]);
  });

  it("defaults pack quantity to 3 when omitted", () => {
    const result = normalizeVotersInput({ pack: "arch" }, defaults);
    expect(result).toHaveLength(3);
  });

  it("throws on a malformed input object (no pack key)", () => {
    // @ts-expect-error — deliberate wrong shape
    expect(() => normalizeVotersInput({ quantity: 2 }, defaults)).toThrow(/voters must be/);
  });

  it("throws on a scalar input", () => {
    // @ts-expect-error — deliberate wrong type
    expect(() => normalizeVotersInput("arch", defaults)).toThrow(/voters must be/);
  });
});
