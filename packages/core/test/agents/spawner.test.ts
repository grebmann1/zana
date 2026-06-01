import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findClaude } from "@zana-ai/core/src/agents/spawner.ts";

describe("findClaude", () => {
  const originalBin = process.env.ZANA_WORKER_BIN;

  beforeEach(() => {
    delete process.env.ZANA_WORKER_BIN;
  });

  afterEach(() => {
    if (originalBin === undefined) delete process.env.ZANA_WORKER_BIN;
    else process.env.ZANA_WORKER_BIN = originalBin;
  });

  it("ZANA_WORKER_BIN takes precedence over ~/.local/bin/claude and PATH", () => {
    process.env.ZANA_WORKER_BIN = "/custom/path/to/my-worker";
    expect(findClaude()).toBe("/custom/path/to/my-worker");
  });

  it("returns a non-empty path when ZANA_WORKER_BIN is unset", () => {
    // We don't assert which path — just that the function still resolves
    // to something (either ~/.local/bin/claude, a PATH match, or the literal
    // "claude" fallback). This guards against a regression where the env
    // override branch accidentally swallows the empty-string case.
    expect(typeof findClaude()).toBe("string");
    expect(findClaude().length).toBeGreaterThan(0);
  });
});
