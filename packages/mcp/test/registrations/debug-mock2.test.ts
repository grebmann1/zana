// This file documents a known limitation: vi.mock() cannot intercept
// @zana-ai/* packages when ssr.noExternal includes /@zana-ai\// in the
// vitest config.  Vite inlines the source before vi.mock can replace the
// module, so require("@zana-ai/extras") always returns the real module.
//
// See workflows.test.ts for the workaround pattern (use real implementations
// with an initialized workspace context instead of mocking @zana-ai/* ).

import { describe, it } from "vitest";

describe("vi.mock @zana-ai/extras — known limitation", () => {
  it.skip(
    "vi.mock cannot intercept @zana-ai/* due to ssr.noExternal — see workflows.test.ts",
    () => {},
  );
});
