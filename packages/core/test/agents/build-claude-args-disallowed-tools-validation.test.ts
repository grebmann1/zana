// buildClaudeArgs — validateProfile() coverage for the `disallowedTools` branch.
//
// validateProfile() guards BOTH tool lists against argv injection, but they are
// two separate loops in spawner.ts (allowedTools: lines 76-82, disallowedTools:
// lines 83-89). The existing suite (build-claude-args.test.ts) only exercises
// the allowedTools loop — a regression that dropped or weakened the
// disallowedTools loop would slip through. These pin that second branch:
//   - control characters in a disallowed tool name must THROW,
//   - a non-string disallowed tool entry must THROW,
//   - a clean disallowed list must pass and flow through to --disallowed-tools.
// Deterministic: pure arg-building, no spawn, no fs, no env dependence.
import { describe, it, expect } from "vitest";

import { buildClaudeArgs } from "@zana-ai/core/src/agents/spawner.ts";

describe("buildClaudeArgs — disallowedTools validation", () => {
  it("throws when a disallowed tool name contains control characters", () => {
    expect(() =>
      buildClaudeArgs({ disallowedTools: ["Bash\x1bInjected"] }),
    ).toThrow(/disallowedTools/);
  });

  it("throws when a disallowed tool entry is not a string", () => {
    expect(() =>
      buildClaudeArgs({ disallowedTools: [42 as unknown as string] }),
    ).toThrow(/disallowedTools/);
  });

  it("accepts a clean disallowed list and emits it after --disallowed-tools", () => {
    const args = buildClaudeArgs({ disallowedTools: ["Bash", "WebFetch"] });
    const idx = args.indexOf("--disallowed-tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Bash");
    expect(args[idx + 2]).toBe("WebFetch");
  });
});
