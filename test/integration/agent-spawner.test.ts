import { describe, it, expect } from "vitest";
import { buildClaudeArgs } from "@zana/core/src/agent-spawner.ts";

describe("agent-spawner", () => {
  describe("buildClaudeArgs", () => {
    it("builds basic args for a minimal profile", () => {
      const profile = { id: "test", displayName: "Test" };
      const args = buildClaudeArgs(profile, { name: "Test Agent" });
      expect(args).toContain("--name");
      expect(args).toContain("Test Agent");
    });

    it("includes model flag", () => {
      const profile = { id: "test", displayName: "Test", model: "claude-sonnet-4-6" };
      const args = buildClaudeArgs(profile);
      expect(args).toContain("--model");
      expect(args).toContain("claude-sonnet-4-6");
    });

    it("includes permission mode", () => {
      const profile = { id: "test", displayName: "Test", permissionMode: "plan" };
      const args = buildClaudeArgs(profile);
      expect(args).toContain("--permission-mode");
      expect(args).toContain("plan");
    });

    it("includes allowed tools", () => {
      const profile = { id: "test", displayName: "Test", allowedTools: ["Read", "Write", "Bash"] };
      const args = buildClaudeArgs(profile);
      expect(args).toContain("--allowed-tools");
      expect(args).toContain("Read");
      expect(args).toContain("Write");
      expect(args).toContain("Bash");
    });

    it("includes effort level", () => {
      const profile = { id: "test", displayName: "Test", effortLevel: "high" };
      const args = buildClaudeArgs(profile);
      expect(args).toContain("--effort");
      expect(args).toContain("high");
    });

    it("includes max budget", () => {
      const profile = { id: "test", displayName: "Test", maxBudgetUsd: 5 };
      const args = buildClaudeArgs(profile);
      expect(args).toContain("--max-budget-usd");
      expect(args).toContain("5");
    });
  });

  describe("profile validation", () => {
    it("rejects invalid permission mode", () => {
      const profile = { id: "test", displayName: "Test", permissionMode: "hacker" };
      expect(() => buildClaudeArgs(profile)).toThrow("invalid permissionMode");
    });

    it("accepts auto permission mode", () => {
      const profile = { id: "test", displayName: "Test", permissionMode: "auto" };
      expect(() => buildClaudeArgs(profile)).not.toThrow();
    });

    it("rejects invalid effort level", () => {
      const profile = { id: "test", displayName: "Test", effortLevel: "turbo" };
      expect(() => buildClaudeArgs(profile)).toThrow("invalid effortLevel");
    });

    it("rejects invalid model name with special chars", () => {
      const profile = { id: "test", displayName: "Test", model: "model; rm -rf /" };
      expect(() => buildClaudeArgs(profile)).toThrow("invalid model name");
    });

    it("rejects control characters in tool names", () => {
      const profile = { id: "test", displayName: "Test", allowedTools: ["Read\x00Evil"] };
      expect(() => buildClaudeArgs(profile)).toThrow("invalid tool name");
    });

    it("rejects negative budget", () => {
      const profile = { id: "test", displayName: "Test", maxBudgetUsd: -1 };
      expect(() => buildClaudeArgs(profile)).toThrow("invalid maxBudgetUsd");
    });

    it("rejects excessively large budget", () => {
      const profile = { id: "test", displayName: "Test", maxBudgetUsd: 99999 };
      expect(() => buildClaudeArgs(profile)).toThrow("invalid maxBudgetUsd");
    });

    it("accepts valid complex profile", () => {
      const profile = {
        id: "complex",
        displayName: "Complex Agent",
        model: "claude-opus-4-6",
        permissionMode: "bypassPermissions",
        effortLevel: "high",
        allowedTools: ["Read", "Write", "Bash", "mcp__server__tool"],
        maxBudgetUsd: 10,
        systemPrompt: "You are a helpful agent.",
      };
      expect(() => buildClaudeArgs(profile)).not.toThrow();
    });
  });
});
