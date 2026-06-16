// The most important UNPINNED behavior in guardrails/builtins.ts is its default
// export (builtins.ts lines 134-143). The source comment states it exists "for
// CJS interop (test does `(await import("...")).default`)" — yet every existing
// guardrails test imports the NAMED exports only, so the default-export object
// is entirely untested. A regression that drops a key from that object, or wires
// a key to the wrong factory, would break CJS consumers while passing the whole
// existing suite. This pins the interop contract: the default export must expose
// all seven guard factories, and each must be the SAME function reference as its
// named counterpart (not a stale divergent copy).

import { describe, it, expect } from "vitest";
import builtins, {
  jsonSchema,
  jsonParse,
  noSecrets,
  maxLength,
  fileExists,
  containsPattern,
  custom,
} from "../../src/guardrails/builtins.ts";

describe("guardrails/builtins — default export (CJS interop)", () => {
  it("exposes exactly the seven guard factories, each identical to its named export", () => {
    const named = {
      jsonSchema,
      jsonParse,
      noSecrets,
      maxLength,
      fileExists,
      containsPattern,
      custom,
    };

    // Same key set — no factory missing, none accidentally added.
    expect(Object.keys(builtins).sort()).toEqual(Object.keys(named).sort());

    // Same function reference per key — the interop object is not a stale copy.
    for (const key of Object.keys(named) as (keyof typeof named)[]) {
      expect(builtins[key]).toBe(named[key]);
    }
  });

  it("default-export factories produce working guards (smoke through one factory)", () => {
    // Prove the references are live: calling through the default export yields a
    // functioning guard, not just a name match.
    const guard = builtins.noSecrets();
    expect(guard.id).toBe("no-secrets");
    expect(guard.validate("plain harmless text").pass).toBe(true);
    expect(guard.validate("key sk-" + "a".repeat(20)).pass).toBe(false);
  });
});
