import { describe, it, expect } from "vitest";
import { normalizeVotersInput } from "@zana-ai/work/src/deliberation/role-packs.ts";

// Guards the `typeof input.pack === "string"` branch in normalizeVotersInput.
// An object that HAS a `pack` key whose value is not a string must be treated
// as malformed input (the voters-must-be error), NOT coerced into resolveVoters.
// Existing tests cover the no-pack-key, scalar, and null cases — but never an
// object whose `pack` field is present-but-non-string, which is the exact input
// that would regress if the guard were loosened to a truthiness check.
describe("normalizeVotersInput — object with a non-string `pack` field", () => {
  const defaults = ["a", "b"];

  it("throws the voters-must-be error for a numeric `pack` (does NOT call resolveVoters)", () => {
    expect(() =>
      normalizeVotersInput({ pack: 123, quantity: 2 } as any, defaults),
    ).toThrow(/voters must be a string\[\] or \{ pack, quantity \}/);
  });

  it("rejects a non-string `pack` rather than surfacing the unknown-role-pack error", () => {
    // If the guard regressed, resolveVoters would run and throw
    // "unknown role pack: ..." instead. Pin that we never reach that path.
    expect(() => normalizeVotersInput({ pack: 123 } as any, defaults)).not.toThrow(
      /unknown role pack/,
    );
  });

  it("treats an object `pack` value as malformed", () => {
    expect(() =>
      normalizeVotersInput({ pack: { id: "arch" } } as any, defaults),
    ).toThrow(/voters must be a string\[\]/);
  });

  it("leaves the provided defaults untouched on the malformed path", () => {
    try {
      normalizeVotersInput({ pack: 7 } as any, defaults);
    } catch {
      /* expected */
    }
    expect(defaults).toEqual(["a", "b"]);
  });
});
