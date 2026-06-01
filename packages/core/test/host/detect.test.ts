import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isClaudeHost, getHostType } from "@zana-ai/core/src/host/detect.ts";

describe("host/detect", () => {
  const originalOverride = process.env.ZANA_HOST_OVERRIDE;

  beforeEach(() => {
    delete process.env.ZANA_HOST_OVERRIDE;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.ZANA_HOST_OVERRIDE;
    else process.env.ZANA_HOST_OVERRIDE = originalOverride;
  });

  it("ZANA_HOST_OVERRIDE=generic forces non-Claude detection", () => {
    process.env.ZANA_HOST_OVERRIDE = "generic";
    expect(isClaudeHost()).toBe(false);
    expect(getHostType()).toBe("generic");
  });

  it("ZANA_HOST_OVERRIDE=claude forces Claude detection", () => {
    process.env.ZANA_HOST_OVERRIDE = "claude";
    expect(isClaudeHost()).toBe(true);
    expect(getHostType()).toBe("claude");
  });

  it("falls back to ~/.claude existence check", () => {
    const claudeDir = path.join(os.homedir(), ".claude");
    const expected = fs.existsSync(claudeDir);
    expect(isClaudeHost()).toBe(expected);
    expect(getHostType()).toBe(expected ? "claude" : "generic");
  });
});
