// role-packs-spec-identity.test.ts
//
// Pins the (currently UNPINNED) reference-sharing contract of the two pack
// *lookup* helpers, getRolePack / listRolePacks.
//
// resolveVoters returns a fresh `slice` and is already isolation-tested
// (role-packs-result-isolation.test.ts). The spec lookups are different:
//
//   getRolePack(id)  → returns `PACK_SPECS[id]` verbatim (no defensive copy)
//   listRolePacks()  → returns `Object.values(PACK_SPECS)` — a FRESH array,
//                      but whose entries are those SAME shared spec objects.
//
// So a caller that mutates a returned spec in place corrupts the module-private
// registry for every other caller. That aliasing footgun — the lookup analogue
// of runtime-config's nested-defaults-aliasing test — was never locked in.
// These assertions pin the current contract; if role-packs is ever hardened to
// freeze or clone its specs, this test is the intentional-change tripwire.
//
// Pure logic — no I/O, no real Claude. Any deliberate mutation is healed in the
// same test so it cannot bleed into sibling files via the shared module.

import { describe, it, expect } from "vitest";
import {
  getRolePack,
  listRolePacks,
} from "@zana-ai/work/src/deliberation/role-packs.ts";

describe("role-packs spec lookups hand out shared registry references", () => {
  it("getRolePack returns the SAME spec object identity on repeated calls", () => {
    const a = getRolePack("arch");
    const b = getRolePack("arch");
    expect(a).not.toBeNull();
    expect(b).toBe(a); // no defensive copy — same reference each call
  });

  it("listRolePacks returns a fresh array whose entries are those same shared specs", () => {
    const first = listRolePacks();
    const second = listRolePacks();
    // The array container is fresh per call...
    expect(second).not.toBe(first);
    // ...but each element is the very object getRolePack hands back.
    const archFromList = first.find((p) => p.id === "arch");
    expect(archFromList).toBe(getRolePack("arch"));
    // And the same element identity is reused across listRolePacks() calls.
    expect(second.find((p) => p.id === "arch")).toBe(archFromList);
  });

  it("in-place mutation of a returned spec leaks into the registry (no copy on read)", () => {
    const spec = getRolePack("review")!;
    const original = spec.description;
    try {
      // Readonly is compile-time only; JS permits the write.
      (spec as { description: string }).description = "TAMPERED";
      // A subsequent independent lookup sees the corruption — proof the lookup
      // returns the shared reference rather than a copy.
      expect(getRolePack("review")!.description).toBe("TAMPERED");
      expect(listRolePacks().find((p) => p.id === "review")!.description).toBe(
        "TAMPERED",
      );
    } finally {
      // Heal the singleton so this footgun cannot corrupt sibling test files.
      (spec as { description: string }).description = original;
    }
    expect(getRolePack("review")!.description).toBe(original);
  });
});
