// role-packs-full-ladder-ordering.test.ts
//
// Pins the COMPLETE, ordered voter ladder for each role pack at full depth.
//
// Gap this closes:
//   - role-packs.test.ts pins only arch@3's ordering plus assorted lengths.
//   - role-packs-generalist-invariant.test.ts checks `.toContain("researcher")`
//     and a couple of individual generalist slots — never the full ordering.
//   So a regression that reordered the non-generalist tail of a ladder (e.g.
//   code-review's performance-engineer ↔ architect, or plan's api-designer ↔
//   performance-engineer) would slip past every existing assertion while still
//   satisfying the generalist-seat invariant. The file's headline contract is
//   deterministic replay: "given (packId, quantity) the same voter list comes
//   back." This test locks that exact list for all four packs.
//
// Pure logic — no I/O, no real Claude.

import { describe, it, expect } from "vitest";
import { resolveVoters } from "@zana-ai/work/src/deliberation/role-packs.ts";

// The full, ordered ladders as documented in role-packs.ts. Resolving at a
// quantity >= ladder length must return the entire ladder in this exact order.
const FULL_LADDERS: Record<string, string[]> = {
  arch: [
    "security-reviewer",
    "performance-engineer",
    "researcher",
    "api-designer",
    "architect",
  ],
  "code-review": [
    "code-reviewer",
    "security-reviewer",
    "researcher",
    "performance-engineer",
    "architect",
  ],
  plan: [
    "architect",
    "researcher",
    "security-reviewer",
    "api-designer",
    "performance-engineer",
  ],
  review: [
    "researcher",
    "code-reviewer",
    "security-reviewer",
    "performance-engineer",
    "architect",
  ],
};

describe("resolveVoters — full ladder ordering is pinned per pack", () => {
  for (const [pack, expected] of Object.entries(FULL_LADDERS)) {
    it(`returns the complete ${pack} ladder in documented order at full depth`, () => {
      // quantity equals ladder length → entire ladder, exact order.
      expect(resolveVoters(pack, expected.length)).toEqual(expected);
    });

    it(`${pack}: every prefix is the ladder sliced to that quantity`, () => {
      // The deterministic-replay contract: resolving N is exactly the first N
      // entries of the full ladder — no reshuffling as depth grows.
      for (let q = 1; q <= expected.length; q++) {
        expect(resolveVoters(pack, q)).toEqual(expected.slice(0, q));
      }
    });
  }
});
