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

describe("ticket-watcher VERDICT parsing + state transitions", () => {
  let tmpDir: string | null = null;
  let watcher: any = null;

  afterEach(() => {
    if (watcher) {
      try { watcher._setServiceOverride(null); } catch {}
      try { watcher._setReadTicketOverride(null); } catch {}
      if (watcher.isRunning()) watcher.stop();
    }
    watcher = null;
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    tmpDir = null;
  });

  it("parseVerdict extracts kind + reason from various line shapes", async () => {
    watcher = await import("@zana/work/src/tickets/watcher.ts");
    const pv = watcher.parseVerdict;

    expect(pv("Looks good.\nVERDICT: PASS")).toEqual({ kind: "PASS", reason: null });
    expect(pv("Issues remain.\nVERDICT: FAIL — needs more tests")).toEqual({ kind: "FAIL", reason: "needs more tests" });
    expect(pv("VERDICT: FAIL - hyphen variant")).toEqual({ kind: "FAIL", reason: "hyphen variant" });
    expect(pv("Done.\nVERDICT: READY")).toEqual({ kind: "READY", reason: null });
    expect(pv("Blocked.\nVERDICT: BLOCKED — upstream dep missing")).toEqual({ kind: "BLOCKED", reason: "upstream dep missing" });
    expect(pv("No verdict here.")).toBeNull();
    expect(pv("")).toBeNull();
    expect(pv(null as any)).toBeNull();
  });

  it("PASS in qa phase advances reviewPhase qa→architecture", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-verdict-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana/work/src/tickets/watcher.ts");
    const core: any = await import("@zana/core");
    const bus = core.events.bus.bus;

    const fakeTicket = {
      id: "t-pass-" + Date.now(),
      title: "PASS verdict test",
      description: "",
      status: "review",
      reviewPhase: "qa",
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "code-reviewer",
    };
    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));

    // Stub service: capture calls + mutate the in-memory fakeTicket so
    // subsequent reads see the new state.
    const calls: any[] = [];
    const stubService = {
      addComment: (...args: any[]) => { calls.push(["addComment", ...args]); return { ok: true }; },
      updateReviewPhase: (id: string, phase: string, actor: string) => {
        calls.push(["updateReviewPhase", id, phase, actor]);
        if (id === fakeTicket.id) fakeTicket.reviewPhase = phase;
        return { ok: true, ticket: fakeTicket };
      },
      updateStatus: (id: string, status: string, actor: string) => {
        calls.push(["updateStatus", id, status, actor]);
        if (id === fakeTicket.id) {
          fakeTicket.status = status;
          if (status === "rework") fakeTicket.reworkCount = (fakeTicket.reworkCount || 0) + 1;
        }
        return { ok: true, ticket: fakeTicket };
      },
      completeTicket: (id: string, summary: string, actor: string) => {
        calls.push(["completeTicket", id, summary, actor]);
        if (id === fakeTicket.id) fakeTicket.status = "done";
        return { ok: true, ticket: fakeTicket };
      },
      getTicket: (id: string) => (id === fakeTicket.id ? fakeTicket : null),
    };
    watcher._setServiceOverride(stubService);

    let capturedSpawn: any = null;
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/path/automation.json",
      spawnAgent: (profileId: string, prompt: string, ticketId: string) => {
        capturedSpawn = { profileId, prompt, ticketId };
        return Promise.resolve({ agentId: "fake-agent-pass-1" });
      },
    });

    // Trigger the watcher's review/qa rule by emitting a status change.
    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });

    // Wait for debounce + spawnFn promise resolution.
    await new Promise((r) => setTimeout(r, 300));
    expect(capturedSpawn).toBeTruthy();
    expect(capturedSpawn.profileId).toBe("code-reviewer");

    // Now the agent "terminates" with a PASS verdict.
    bus.emit("agent:terminated", {
      agentId: "fake-agent-pass-1",
      profileId: "code-reviewer",
      reason: "completed",
      exitCode: 0,
      output: "Code looks correct, no security issues.\nVERDICT: PASS",
    });

    // Give the synchronous handler a tick to run.
    await new Promise((r) => setTimeout(r, 20));

    // applyVerdict should have advanced the phase.
    expect(fakeTicket.reviewPhase).toBe("architecture");
    expect(fakeTicket.status).toBe("review");
    const phaseCall = calls.find((c) => c[0] === "updateReviewPhase");
    expect(phaseCall).toBeTruthy();
    expect(phaseCall[2]).toBe("architecture");
    expect(phaseCall[3]).toBe("ticket-watcher");
    expect(calls.find((c) => c[0] === "addComment")).toBeTruthy();
  });

  it("FAIL transitions status→rework and increments reworkCount", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-verdict-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana/work/src/tickets/watcher.ts");
    const core: any = await import("@zana/core");
    const bus = core.events.bus.bus;

    const fakeTicket = {
      id: "t-fail-" + Date.now(),
      title: "FAIL verdict test",
      description: "",
      status: "review",
      reviewPhase: "qa",
      labels: [],
      reworkCount: 0,
      assigneeProfileId: "code-reviewer",
    };
    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));

    const calls: any[] = [];
    const stubService = {
      addComment: (...args: any[]) => { calls.push(["addComment", ...args]); return { ok: true }; },
      updateReviewPhase: (id: string, phase: string, actor: string) => {
        calls.push(["updateReviewPhase", id, phase, actor]);
        if (id === fakeTicket.id) fakeTicket.reviewPhase = phase;
        return { ok: true, ticket: fakeTicket };
      },
      updateStatus: (id: string, status: string, actor: string) => {
        calls.push(["updateStatus", id, status, actor]);
        if (id === fakeTicket.id) {
          fakeTicket.status = status;
          if (status === "rework") {
            fakeTicket.reworkCount = (fakeTicket.reworkCount || 0) + 1;
            fakeTicket.reviewPhase = null;
          }
        }
        return { ok: true, ticket: fakeTicket };
      },
      completeTicket: (id: string, summary: string, actor: string) => {
        calls.push(["completeTicket", id, summary, actor]);
        return { ok: true, ticket: fakeTicket };
      },
      getTicket: (id: string) => (id === fakeTicket.id ? fakeTicket : null),
    };
    watcher._setServiceOverride(stubService);

    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/path/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "fake-agent-fail-1" }),
    });

    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "in-progress",
      newStatus: "review",
      updatedBy: "test",
    });
    await new Promise((r) => setTimeout(r, 300));

    bus.emit("agent:terminated", {
      agentId: "fake-agent-fail-1",
      profileId: "code-reviewer",
      reason: "completed",
      exitCode: 0,
      output: "Found a bug at line 5: off-by-one in loop bound.\nVERDICT: FAIL — off-by-one in average() loop",
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(fakeTicket.status).toBe("rework");
    expect(fakeTicket.reworkCount).toBe(1);
    const statusCall = calls.find((c) => c[0] === "updateStatus" && c[2] === "rework");
    expect(statusCall).toBeTruthy();
    expect(statusCall[3]).toBe("ticket-watcher");

    const commentCall = calls.find((c) => c[0] === "addComment");
    expect(commentCall).toBeTruthy();
    // Comment body should embed verdict + reason.
    expect(commentCall[4]).toContain("FAIL");
    expect(commentCall[4]).toContain("off-by-one");
  });
});
