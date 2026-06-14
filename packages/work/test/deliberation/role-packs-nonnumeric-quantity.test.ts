import { describe, it, expect } from "vitest";
import { normalizeVotersInput } from "@zana-ai/work/src/deliberation/role-packs.ts";

// ─────────────────────────────────────────────────────────────────────────────
// normalizeVotersInput — pack object whose `quantity` is present but NOT a number.
// Line 124 of role-packs.ts only treats `quantity` as authoritative when
// `typeof input.quantity === "number"`; any other type must fall back to the
// default of 3. Existing tests cover explicit-number and omitted-quantity, but
// not this present-yet-non-numeric branch.
// Pure logic — no I/O, no real Claude.
// ─────────────────────────────────────────────────────────────────────────────
describe("normalizeVotersInput — non-numeric quantity falls back to default 3", () => {
  const defaults = ["x", "y"];

  it("treats a string quantity as omitted (defaults to 3 voters)", () => {
    // Mirrors the omitted-quantity case: arch ladder first 3 entries.
    const result = normalizeVotersInput(
      { pack: "arch", quantity: "5" as any },
      defaults,
    );
    expect(result).toEqual([
      "security-reviewer",
      "performance-engineer",
      "researcher",
    ]);
  });

  it("treats a null quantity as omitted (defaults to 3 voters)", () => {
    const result = normalizeVotersInput(
      { pack: "code-review", quantity: null as any },
      defaults,
    );
    expect(result).toEqual([
      "code-reviewer",
      "security-reviewer",
      "researcher",
    ]);
  });

  it("does not mutate or return the provided defaults for a valid pack", () => {
    const result = normalizeVotersInput(
      { pack: "review", quantity: undefined },
      defaults,
    );
    expect(result).not.toBe(defaults);
    expect(defaults).toEqual(["x", "y"]);
  });
});
