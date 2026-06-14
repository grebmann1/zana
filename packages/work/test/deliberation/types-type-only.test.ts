// Contract test for packages/work/src/deliberation/types.ts
//
// types.ts is documented as a pure, audit-grade *types* module — it should
// carry only TypeScript `type`/`interface` declarations and emit NO runtime
// code. This guards that invariant: if someone accidentally adds a runtime
// const, function, enum, or class to the file, the transpiled module would
// gain a runtime export and this test would fail, prompting a move to a
// proper runtime module.

import { describe, it, expect } from "vitest";
import * as types from "@zana-ai/work/src/deliberation/types.ts";

describe("deliberation/types.ts is type-only", () => {
  it("emits no runtime exports", () => {
    // Type-only declarations are erased during transpilation, leaving an
    // empty module namespace object.
    expect(Object.keys(types)).toEqual([]);
  });

  it("has no default export", () => {
    expect((types as Record<string, unknown>).default).toBeUndefined();
  });
});
