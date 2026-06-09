// This file documents a known limitation: vi.mock() cannot intercept
// @zana-ai/* dist paths when ssr.noExternal includes /@zana-ai\// in the
// vitest config.  Vite inlines the source before vi.mock can replace the
// module, so the real workflow-engine is always loaded.
//
// See workflows.test.ts for the workaround pattern (use real implementations
// with an initialized workspace context instead of mocking dist paths).

import { describe, it } from "vitest";

describe("vi.mock @zana-ai/work dist path — known limitation", () => {
  it.skip(
    "vi.mock cannot intercept @zana-ai/* dist paths due to ssr.noExternal — see workflows.test.ts",
    () => {},
  );
});
