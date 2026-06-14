// Deterministic coverage for the precedence rule in host/detect.ts: the
// ZANA_HOST_OVERRIDE env var must SHORT-CIRCUIT the `~/.claude` filesystem
// check. The existing detect.test.ts sets the override but never controls the
// filesystem, and detect-fs-fallback.test.ts drives the filesystem only with
// NO override set — so neither proves the override wins over a contradicting
// filesystem state. That precedence is what lets the hook installer skip
// silently on a non-Claude host even when ~/.claude happens to exist.
//
// We mock node:fs (same strategy as detect-fs-fallback.test.ts) so we can pin
// the filesystem to the OPPOSITE of the override and assert the override wins.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Tracks whether production code ever consulted the filesystem.
let existsCalls = 0;
let existsResult = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (_p: any) => {
      existsCalls += 1;
      return existsResult;
    },
  };
});

// Import after vi.mock so production code binds the mocked fs.
import { isClaudeHost, getHostType } from "@zana-ai/core/src/host/detect.ts";

describe("host/detect — env override beats the filesystem", () => {
  const originalOverride = process.env.ZANA_HOST_OVERRIDE;

  beforeEach(() => {
    existsCalls = 0;
    existsResult = false;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.ZANA_HOST_OVERRIDE;
    else process.env.ZANA_HOST_OVERRIDE = originalOverride;
  });

  it("override=generic forces 'generic' even when ~/.claude exists on disk", () => {
    process.env.ZANA_HOST_OVERRIDE = "generic";
    existsResult = true; // filesystem says "claude" — override must win

    expect(isClaudeHost()).toBe(false);
    expect(getHostType()).toBe("generic");
    // The override short-circuits before the fs check is ever reached.
    expect(existsCalls).toBe(0);
  });

  it("override=claude forces 'claude' even when ~/.claude is absent", () => {
    process.env.ZANA_HOST_OVERRIDE = "claude";
    existsResult = false; // filesystem says "generic" — override must win

    expect(isClaudeHost()).toBe(true);
    expect(getHostType()).toBe("claude");
    expect(existsCalls).toBe(0);
  });
});
