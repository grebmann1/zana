// Deterministic coverage for an UNRECOGNIZED ZANA_HOST_OVERRIDE value in
// host/detect.ts. The override is matched with strict equality against exactly
// "generic" / "claude" (detect.ts lines 17-18); any other value — a typo, the
// wrong case ("Claude"), a truthy-but-unrelated string ("1"/"yes"), or empty —
// must NOT force a host type. It has to fall THROUGH to the `~/.claude`
// filesystem probe. The sibling detect-override-precedence.test.ts only pins
// the two exact-match values (and asserts the fs check is skipped); detect-
// fs-fallback.test.ts drives the fs branch only with NO override set. Neither
// proves that a *malformed* override still consults the filesystem — a
// regression that did a loose/case-insensitive/truthy check on the override
// would silently mis-detect the host and pass every existing test.
//
// Strategy mirrors detect-override-precedence.test.ts: mock node:fs so we can
// pin the filesystem result and assert it was actually consulted.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

describe("host/detect — unrecognized override falls through to the fs probe", () => {
  const originalOverride = process.env.ZANA_HOST_OVERRIDE;

  beforeEach(() => {
    existsCalls = 0;
    existsResult = false;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.ZANA_HOST_OVERRIDE;
    else process.env.ZANA_HOST_OVERRIDE = originalOverride;
  });

  // Wrong case must NOT match the strict "claude" literal — it falls through,
  // and with ~/.claude absent the host resolves to generic.
  it("treats a wrong-case 'Claude' as unrecognized and consults the filesystem", () => {
    process.env.ZANA_HOST_OVERRIDE = "Claude";
    existsResult = false;

    expect(isClaudeHost()).toBe(false);
    expect(getHostType()).toBe("generic");
    expect(existsCalls).toBeGreaterThan(0); // fs WAS consulted (no short-circuit)
  });

  it.each(["1", "yes", "true", ""])(
    "treats override=%j as unrecognized and defers to the filesystem result",
    (val) => {
      process.env.ZANA_HOST_OVERRIDE = val;
      // Filesystem says "claude"; since the override is not a recognized
      // literal, the fs result — not the override string — decides the host.
      existsResult = true;

      expect(isClaudeHost()).toBe(true);
      expect(getHostType()).toBe("claude");
      expect(existsCalls).toBeGreaterThan(0);
    },
  );
});
