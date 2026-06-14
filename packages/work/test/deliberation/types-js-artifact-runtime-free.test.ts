// Contract test for packages/work/src/deliberation/types.js
//
// types.js is the committed transpiled artifact of the type-only types.ts
// module. types.ts is documented as a pure, audit-grade *types* module that
// must emit NO runtime code. The companion test (types-type-only.test.ts)
// guards the *source* invariant; this test guards the *emitted artifact*, so
// that drift between the two — e.g. a stale or hand-edited .js that smuggles
// in a runtime const/function/enum — is caught instead of shipping silently.

import { describe, it, expect } from "vitest";
import * as typesJs from "@zana-ai/work/src/deliberation/types.js";

describe("deliberation/types.js artifact is runtime-free", () => {
  it("exposes no named runtime exports", () => {
    // The only key permitted is the CJS→ESM interop `default`; a type-only
    // module must not contribute any named runtime binding.
    const namedKeys = Object.keys(typesJs).filter((k) => k !== "default");
    expect(namedKeys).toEqual([]);
  });

  it("carries no runtime values on its default interop object", () => {
    // Even via the `default` interop shim, the transpiled exports object must
    // hold no own enumerable runtime members (only the non-enumerable
    // `__esModule` marker may exist).
    const dflt = (typesJs as Record<string, unknown>).default;
    const defaultKeys = dflt == null ? [] : Object.keys(dflt as object);
    expect(defaultKeys).toEqual([]);
  });
});
