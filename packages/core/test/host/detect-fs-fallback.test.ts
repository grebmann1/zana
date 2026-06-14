// Deterministic coverage for the `~/.claude` filesystem fallback in
// host/detect.ts. The existing detect.test.ts asserts the fallback against
// whatever the live machine happens to have on disk, so it can only ever
// exercise ONE branch (and is environment-dependent). Here we mock node:fs
// to drive BOTH branches deterministically, with no override set.
//
// Strategy mirrors lifecycle-check-resources.test.ts: vi.mock the core module
// with a factory that reads a mutable slot at call time, so each test can flip
// the result without re-importing production code.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// Mutable slot the mock factory consults on every existsSync() call.
let existsImpl: (p: string) => boolean = () => false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: any) => existsImpl(String(p)),
  };
});

// Import after vi.mock so production code binds the mocked fs.
import { isClaudeHost, getHostType } from "@zana-ai/core/src/host/detect.ts";

describe("host/detect — ~/.claude fs fallback (no override)", () => {
  const originalOverride = process.env.ZANA_HOST_OVERRIDE;
  const claudeDir = path.join(os.homedir(), ".claude");

  beforeEach(() => {
    // Force the fallback path: env override must be unset.
    delete process.env.ZANA_HOST_OVERRIDE;
    existsImpl = () => false;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.ZANA_HOST_OVERRIDE;
    else process.env.ZANA_HOST_OVERRIDE = originalOverride;
  });

  it("detects a Claude host when ~/.claude exists", () => {
    const seen: string[] = [];
    existsImpl = (p) => {
      seen.push(p);
      return p === claudeDir;
    };

    expect(isClaudeHost()).toBe(true);
    expect(getHostType()).toBe("claude");
    expect(seen).toContain(claudeDir);
  });

  it("detects a generic host when ~/.claude is absent", () => {
    existsImpl = () => false;

    expect(isClaudeHost()).toBe(false);
    expect(getHostType()).toBe("generic");
  });

  it("re-evaluates the filesystem on every call (no caching)", () => {
    // Documented invariant: an installer can create ~/.claude mid-session,
    // so detection must re-read the filesystem rather than memoize.
    existsImpl = () => false;
    expect(isClaudeHost()).toBe(false);

    existsImpl = (p) => p === claudeDir;
    expect(isClaudeHost()).toBe(true);
  });
});
