// This file documents a known limitation: vi.mock() cannot intercept
// @zana-ai/* packages when ssr.noExternal includes /@zana-ai\// in the
// vitest config.  Vite inlines the source before vi.mock can replace the
// module, so require("@zana-ai/work") always returns the real module.
//
// The limitation is accounted for in workflows.test.ts which avoids vi.mock
// for @zana-ai/* and uses the real implementations with a workspace context.
//
// These tests are skipped rather than deleted so the constraint stays visible.

import { describe, it } from "vitest";

describe("vi.mock @zana-ai/work — known limitation", () => {
  it.skip(
    "vi.mock cannot intercept @zana-ai/* due to ssr.noExternal — see workflows.test.ts",
    () => {},
  );
});
