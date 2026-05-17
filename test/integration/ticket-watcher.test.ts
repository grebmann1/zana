import { describe, it, expect } from "vitest";

describe("ticket-watcher loadRules fallback", () => {
  it("falls back to defaults when config has no automation array", async () => {
    const watcher = await import("@zana/work/src/tickets/watcher.ts");
    // Pass a path that doesn't exist — forces the catch branch
    watcher.loadRules("/nonexistent/path/automation.json");
    const rules = watcher.getRules();
    expect(rules.length).toBe(3);
    const profiles = rules.map((r: any) => r.action.spawnProfile).sort();
    expect(profiles).toEqual(["architect", "code-reviewer", "{{assigneeProfileId}}"]);
  });

  it("default rules use renamed profile IDs (no built-in- prefix)", async () => {
    const watcher = await import("@zana/work/src/tickets/watcher.ts");
    watcher.loadRules("/nonexistent/path");
    const rules = watcher.getRules();
    const stale = rules.filter((r: any) => /^built-in-/.test(r.action.spawnProfile));
    expect(stale).toEqual([]);
  });
});
