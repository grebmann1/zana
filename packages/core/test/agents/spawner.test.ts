import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findClaude, buildInteractiveCommand } from "@zana-ai/core/src/agents/spawner.ts";

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

describe("buildInteractiveCommand", () => {
  const originalBin = process.env.ZANA_WORKER_BIN;

  beforeEach(() => {
    // Pin the binary so assertions on `command` are deterministic
    process.env.ZANA_WORKER_BIN = "/fake/claude";
  });

  afterEach(() => {
    if (originalBin === undefined) delete process.env.ZANA_WORKER_BIN;
    else process.env.ZANA_WORKER_BIN = originalBin;
  });

  it("returns an object with command and args properties", () => {
    const result = buildInteractiveCommand({});
    expect(result).toHaveProperty("command");
    expect(result).toHaveProperty("args");
    expect(Array.isArray(result.args)).toBe(true);
  });

  it("command is derived from ZANA_WORKER_BIN / findClaude()", () => {
    const result = buildInteractiveCommand({});
    expect(result.command).toBe("/fake/claude");
  });

  it("profile model flows through to --model arg", () => {
    const { args } = buildInteractiveCommand({ model: "claude-opus-4-5" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-opus-4-5");
  });

  it("options.name flows through to --name arg", () => {
    const { args } = buildInteractiveCommand({}, { name: "my-agent" });
    const idx = args.indexOf("--name");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("my-agent");
  });

  it("profile permissionMode flows through to --permission-mode arg", () => {
    const { args } = buildInteractiveCommand({ permissionMode: "plan" });
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("plan");
  });

  it("throws on an invalid profile (delegates to validateProfile)", () => {
    expect(() =>
      buildInteractiveCommand({ permissionMode: "god-mode" } as any)
    ).toThrow(/permissionMode/);
  });
});
