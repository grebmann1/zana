import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

describe("ticket-watcher in-process bus delivery", () => {
  let tmpDir: string | null = null;
  let watcher: any = null;

  afterEach(() => {
    if (watcher && watcher.isRunning()) watcher.stop();
    watcher = null;
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    tmpDir = null;
  });

  it("reacts to ticket:statusChanged via bus and updates processedStates", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-bus-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana/work/src/tickets/watcher.ts");
    const core: any = await import("@zana/core");
    const bus = core.events.bus.bus;

    // Inject a fake ticket reader so we don't depend on the real store
    // (in vitest, module isolation means require("./service") inside the
    // watcher resolves to a different instance than the test's import).
    const fakeTicketId = "test-ticket-bus-rearch-" + Date.now();
    const fakeTicket = {
      id: fakeTicketId,
      title: "Bus delivery test",
      description: "",
      status: "review",
      reviewPhase: "qa",
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "code-reviewer",
    };
    watcher._setReadTicketOverride((id: string) => (id === fakeTicketId ? fakeTicket : null));

    let spawnCalls = 0;
    const spawnLog: any[] = [];
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/path/automation.json",
      spawnAgent: (profileId: string, prompt: string, ticketId: string) => {
        spawnCalls++;
        spawnLog.push({ profileId, ticketId });
      },
    });
    expect(watcher.isRunning()).toBe(true);

    // Emit the bus event directly — this is exactly what service.updateStatus
    // does in production (line 111 of service.ts). The watcher's listener
    // debounces and then dispatches to the rule engine.
    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicketId,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });

    // Wait for the 150ms debounce + small buffer.
    await new Promise((r) => setTimeout(r, 300));

    const processed = watcher._getProcessedStates();
    const key = processed.get(fakeTicketId);
    expect(key).toBeTruthy();
    const parsed = JSON.parse(key);
    expect(parsed.status).toBe("review");
    expect(parsed.reviewPhase).toBe("qa");

    // The default "review/qa" rule should have triggered a spawn.
    expect(spawnCalls).toBeGreaterThanOrEqual(1);
    expect(spawnLog[0].profileId).toBe("code-reviewer");
    expect(spawnLog[0].ticketId).toBe(fakeTicketId);

    watcher._setReadTicketOverride(null);
  });
});
