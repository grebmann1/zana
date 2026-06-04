// buildClaudeArgs — arg generation and profile validation.
//
// NOTE: spawner.ts loads skillStore via a lazy Proxy that calls
// require("@zana-ai/extras") at call-time. vi.mock() does not intercept
// that dynamic CJS require in vitest SSR mode, so the real skillStore
// (and its global skills from disk) is always active here.
// Tests below are written to be deterministic regardless of which global
// skills happen to be installed — they assert on structure, not content.
import { describe, it, expect } from "vitest";

import { buildClaudeArgs } from "@zana-ai/core/src/agents/spawner.ts";

// Helper: find the value immediately following a CLI flag in an args array.
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe("buildClaudeArgs — basic arg generation", () => {
  it("adds --name from options.name", () => {
    const args = buildClaudeArgs({}, { name: "Coder" });
    expect(args).toContain("--name");
    expect(flagValue(args, "--name")).toBe("Coder");
  });

  it("falls back to profile.displayName when options.name is absent", () => {
    const args = buildClaudeArgs({ displayName: "Reviewer" });
    expect(flagValue(args, "--name")).toBe("Reviewer");
  });

  it("options.name takes priority over profile.displayName", () => {
    const args = buildClaudeArgs({ displayName: "Reviewer" }, { name: "Override" });
    expect(flagValue(args, "--name")).toBe("Override");
  });

  it("adds --system-prompt from profile.systemPrompt", () => {
    const args = buildClaudeArgs({ systemPrompt: "You are helpful." });
    expect(args).toContain("--system-prompt");
    expect(flagValue(args, "--system-prompt")).toBe("You are helpful.");
  });

  it("adds --model", () => {
    const args = buildClaudeArgs({ model: "claude-sonnet-4-6" });
    expect(args).toContain("--model");
    expect(flagValue(args, "--model")).toBe("claude-sonnet-4-6");
  });

  it("adds --effort from effortLevel", () => {
    const args = buildClaudeArgs({ effortLevel: "high" });
    expect(args).toContain("--effort");
    expect(flagValue(args, "--effort")).toBe("high");
  });

  it("adds --permission-mode from permissionMode", () => {
    const args = buildClaudeArgs({ permissionMode: "auto" });
    expect(args).toContain("--permission-mode");
    expect(flagValue(args, "--permission-mode")).toBe("auto");
  });

  it("spreads --allowed-tools", () => {
    const args = buildClaudeArgs({ allowedTools: ["Read", "Edit"] });
    const idx = args.indexOf("--allowed-tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Read");
    expect(args[idx + 2]).toBe("Edit");
  });

  it("spreads --disallowed-tools", () => {
    const args = buildClaudeArgs({ disallowedTools: ["Bash"] });
    const idx = args.indexOf("--disallowed-tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Bash");
  });

  it("adds --max-budget-usd when maxBudgetUsd is set", () => {
    const args = buildClaudeArgs({ maxBudgetUsd: 5 });
    expect(args).toContain("--max-budget-usd");
    expect(flagValue(args, "--max-budget-usd")).toBe("5");
  });
});

describe("buildClaudeArgs — skillStore integration (structural invariants)", () => {
  it("always emits --append-system-prompt with the ZANA SKILLS header", () => {
    // Global skills are loaded from disk; regardless of which skills are
    // installed the marker and header must appear.
    const args = buildClaudeArgs({ id: "any-profile" });
    const val = flagValue(args, "--append-system-prompt");
    expect(val).toBeDefined();
    expect(val).toContain("--- ZANA SKILLS ---");
  });

  it("when appendSystemPrompt is set it appears first, skills block is appended", () => {
    const args = buildClaudeArgs({ id: "p1", appendSystemPrompt: "base-instructions" });
    const val = flagValue(args, "--append-system-prompt")!;
    expect(val).toBeDefined();
    // User-provided base comes before the skills block
    expect(val.indexOf("base-instructions")).toBeLessThan(val.indexOf("--- ZANA SKILLS ---"));
  });
});

describe("buildClaudeArgs — profile validation", () => {
  it("throws on invalid permissionMode", () => {
    expect(() => buildClaudeArgs({ permissionMode: "superuser" } as any)).toThrow(/permissionMode/);
  });

  it("throws on invalid effortLevel", () => {
    expect(() => buildClaudeArgs({ effortLevel: "extreme" } as any)).toThrow(/effortLevel/);
  });

  it("throws on model name with illegal characters", () => {
    expect(() => buildClaudeArgs({ model: "claude; rm -rf /" })).toThrow(/model/);
  });

  it("throws when a tool name contains control characters", () => {
    expect(() => buildClaudeArgs({ allowedTools: ["Bad\x00Tool"] })).toThrow(/allowedTools/);
  });

  it("throws when maxBudgetUsd is negative", () => {
    expect(() => buildClaudeArgs({ maxBudgetUsd: -1 } as any)).toThrow(/maxBudgetUsd/);
  });

  it("throws when maxBudgetUsd exceeds ceiling", () => {
    expect(() => buildClaudeArgs({ maxBudgetUsd: 99999 } as any)).toThrow(/maxBudgetUsd/);
  });

  it("accepts all valid permissionModes without throwing", () => {
    const modes = ["default", "plan", "auto", "acceptEdits", "bypassPermissions", "dontAsk"];
    for (const mode of modes) {
      expect(() => buildClaudeArgs({ permissionMode: mode })).not.toThrow();
    }
  });
});
