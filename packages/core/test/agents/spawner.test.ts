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

  it("worker profiles get the ticket-lifecycle preamble appended", () => {
    const { args } = buildInteractiveCommand({ id: "backend-dev", systemPrompt: "be a backend dev" });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = args[idx + 1];
    expect(block).toContain("--- TICKET LIFECYCLE ---");
    expect(block).toContain("zana_ticket_claim");
    expect(block).toContain("zana_ticket_complete");
  });

  it("orchestrator profiles do NOT get the lifecycle preamble (they own the workflow already)", () => {
    const { args } = buildInteractiveCommand({ id: "orchestrator", systemPrompt: "orchestrate" });
    const idx = args.indexOf("--append-system-prompt");
    if (idx === -1) return; // no append at all is also fine
    expect(args[idx + 1] || "").not.toContain("--- TICKET LIFECYCLE ---");
  });

  // ticketLifecyclePreamble (spawner.ts) skips two profile shapes:
  // `id.includes("orchestrator")` OR `id === "swarm-master"`. The sibling test
  // above covers only the substring "orchestrator" arm — the exact-match
  // "swarm-master" arm is otherwise unpinned, so a regression dropping that
  // OR-clause (e.g. collapsing to just the includes() check) would still pass
  // every other test while wrongly handing the swarm master a worker-shaped
  // ticket-lifecycle preamble. This pins the swarm-master skip.
  it("the swarm-master profile does NOT get the lifecycle preamble", () => {
    const { args } = buildInteractiveCommand({ id: "swarm-master", systemPrompt: "coordinate the swarm" });
    const idx = args.indexOf("--append-system-prompt");
    if (idx === -1) return; // no append block at all is also acceptable
    expect(args[idx + 1] || "").not.toContain("--- TICKET LIFECYCLE ---");
  });

  it("preserves a profile's existing appendSystemPrompt and concatenates the lifecycle block", () => {
    const { args } = buildInteractiveCommand({
      id: "backend-dev",
      appendSystemPrompt: "Use TypeScript strict mode.",
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = args[idx + 1];
    expect(block).toContain("Use TypeScript strict mode.");
    expect(block).toContain("--- TICKET LIFECYCLE ---");
  });
});
