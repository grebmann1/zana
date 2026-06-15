// Focused boundary tests for two unpinned branches of normalizeVotersInput.
//
// role-packs.ts line 121-129:
//   if (input === undefined) return [...defaults];
//   if (Array.isArray(input)) return input;
//   if (input && typeof input === "object" && typeof input.pack === "string") {
//     const quantity = typeof input.quantity === "number" ? input.quantity : 3;
//     return resolveVoters(input.pack, quantity);
//   }
//   throw new Error("voters must be ...");
//
// The existing suite pins: undefined → defaults copy, [] → passthrough,
// populated array → passthrough, object-without-pack → throw, scalar → throw,
// and non-numeric quantity → falls back to 3. Two distinct paths remain
// unlocked:
//   1. `null` is NOT undefined and NOT an object that passes the `input &&`
//      guard, so it must hit the malformed-input throw — it is explicitly NOT
//      treated like an omitted argument (which would return defaults). This is
//      the null-vs-undefined contract, mirroring the empty-array test's intent.
//   2. A pack object whose `quantity` IS a number but is out of range (0 or
//      negative) is forwarded verbatim to resolveVoters — so the ">= 1" error
//      propagates. This differs from the non-numeric branch, which silently
//      defaults to 3. A regression that clamped or defaulted numeric-invalid
//      quantities would swallow a real caller error.
//
// Pure logic — no I/O, no real Claude.
import { describe, it, expect } from "vitest";
import { normalizeVotersInput } from "@zana-ai/work/src/deliberation/role-packs.ts";

describe("normalizeVotersInput — null input and numeric-invalid quantity", () => {
  const defaults = ["researcher", "code-reviewer"];

  it("treats a null input as malformed (throws) — NOT as omitted/defaults", () => {
    // null is not undefined, so it must not return the defaults; the `input &&`
    // guard short-circuits, landing on the malformed-input throw.
    expect(() => normalizeVotersInput(null as any, defaults)).toThrow(/voters must be/);
  });

  it("leaves defaults untouched when given a null input", () => {
    try {
      normalizeVotersInput(null as any, defaults);
    } catch {
      /* expected */
    }
    expect(defaults).toEqual(["researcher", "code-reviewer"]);
  });

  it("propagates resolveVoters' '>= 1' error for a numeric quantity of 0", () => {
    // 0 IS a number, so it is forwarded to resolveVoters rather than defaulting
    // to 3 — the lower-bound guard must surface, not be swallowed.
    expect(() => normalizeVotersInput({ pack: "arch", quantity: 0 }, defaults)).toThrow(
      /quantity must be >= 1/,
    );
  });

  it("propagates resolveVoters' '>= 1' error for a negative numeric quantity", () => {
    expect(() => normalizeVotersInput({ pack: "arch", quantity: -2 }, defaults)).toThrow(
      /quantity must be >= 1/,
    );
  });
});
