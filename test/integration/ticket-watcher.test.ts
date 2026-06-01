import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("ticket-watcher loadRules fallback", () => {
  it("falls back to defaults when config has no automation array", async () => {
    const watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    // Pass a path that doesn't exist — forces the catch branch
    watcher.loadRules("/nonexistent/path/automation.json");
    const rules = watcher.getRules();
    expect(rules.length).toBe(3);
    const profiles = rules.map((r: any) => r.action.spawnProfile).sort();
    expect(profiles).toEqual(["architect", "code-reviewer", "{{assigneeProfileId}}"]);
  });

  it("default rules use renamed profile IDs (no built-in- prefix)", async () => {
    const watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
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

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const core: any = await import("@zana-ai/core");
    const bus = core.events.bus;

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
    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
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

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const core: any = await import("@zana-ai/core");
    const bus = core.events.bus;

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

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const core: any = await import("@zana-ai/core");
    const bus = core.events.bus;

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

describe("ticket-watcher rule schema (event-aware triggers)", () => {
  it("normalizeTrigger rewrites legacy { status, label, reviewPhase } to event shape", async () => {
    const watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const out = watcher.normalizeTrigger({ status: "review", reviewPhase: "qa", label: "urgent" });
    expect(out.event).toBe("ticket:statusChanged");
    expect(out.to).toBe("review");
    expect(out.reviewPhase).toBe("qa");
    expect(out.labels).toEqual(["urgent"]);
  });

  it("normalizeTrigger preserves explicit event shape", async () => {
    const watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const out = watcher.normalizeTrigger({ event: "ticket:created", to: "*", labels: ["a", "b"] });
    expect(out.event).toBe("ticket:created");
    expect(out.to).toBe("*");
    expect(out.labels).toEqual(["a", "b"]);
  });

  it("matchesRule honors from/to wildcards, arrays, and labels", async () => {
    const watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const ticket = { status: "done", reviewPhase: null, labels: ["customer-facing", "p1"] };
    const payload = { ticketId: "t1", oldStatus: "in-progress", newStatus: "done", updatedBy: "u" };

    // Exact to + array from
    expect(watcher.matchesRule(
      { trigger: { event: "ticket:statusChanged", to: "done", from: ["in-progress", "review"] } },
      "ticket:statusChanged", payload, ticket,
    )).toBe(true);

    // Wildcard to
    expect(watcher.matchesRule(
      { trigger: { event: "ticket:statusChanged", to: "*" } },
      "ticket:statusChanged", payload, ticket,
    )).toBe(true);

    // Mismatch from
    expect(watcher.matchesRule(
      { trigger: { event: "ticket:statusChanged", from: "backlog" } },
      "ticket:statusChanged", payload, ticket,
    )).toBe(false);

    // Event mismatch
    expect(watcher.matchesRule(
      { trigger: { event: "ticket:created" } },
      "ticket:statusChanged", payload, ticket,
    )).toBe(false);

    // Labels — all required, present
    expect(watcher.matchesRule(
      { trigger: { event: "ticket:statusChanged", labels: ["p1"] } },
      "ticket:statusChanged", payload, ticket,
    )).toBe(true);

    // Labels — missing
    expect(watcher.matchesRule(
      { trigger: { event: "ticket:statusChanged", labels: ["missing-label"] } },
      "ticket:statusChanged", payload, ticket,
    )).toBe(false);
  });

  it("matchesRule treats legacy bare-status rules as ticket:statusChanged", async () => {
    const watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const ticket = { status: "review", reviewPhase: "qa", labels: [] };
    const payload = { ticketId: "t1", oldStatus: "in-progress", newStatus: "review", updatedBy: "u" };

    expect(watcher.matchesRule(
      { trigger: { status: "review", reviewPhase: "qa" } },
      "ticket:statusChanged", payload, ticket,
    )).toBe(true);

    // Legacy rule should NOT fire on a non-statusChanged event.
    expect(watcher.matchesRule(
      { trigger: { status: "review", reviewPhase: "qa" } },
      "ticket:created", payload, ticket,
    )).toBe(false);
  });
});

describe("ticket-watcher template-context helper", () => {
  it("buildTemplateContext resolves updatedBy across event-specific keys", async () => {
    const tc = await import("@zana-ai/work/src/tickets/template-context.ts");
    const ticket = { id: "t1", status: "review", title: "x" };

    // statusChanged → updatedBy
    expect(tc.buildTemplateContext("ticket:statusChanged",
      { updatedBy: "alice" }, ticket).updatedBy).toBe("alice");

    // commented → authorId
    expect(tc.buildTemplateContext("ticket:commented",
      { authorId: "bob" }, ticket).updatedBy).toBe("bob");

    // completed → completedBy
    expect(tc.buildTemplateContext("ticket:completed",
      { completedBy: "carol" }, ticket).updatedBy).toBe("carol");

    // empty payload → "system"
    expect(tc.buildTemplateContext("ticket:updated", {}, ticket).updatedBy).toBe("system");
  });

  it("renderTemplate substitutes vars; missing keys render as empty string", async () => {
    const tc = await import("@zana-ai/work/src/tickets/template-context.ts");
    const ctx = tc.buildTemplateContext("ticket:statusChanged",
      { oldStatus: "in-progress", newStatus: "done", updatedBy: "alice" },
      { id: "T-1", title: "Hello" },
    );
    expect(tc.renderTemplate("{{id}} {{title}}: {{oldStatus}}→{{newStatus}} by {{updatedBy}}", ctx))
      .toBe("T-1 Hello: in-progress→done by alice");
    expect(tc.renderTemplate("missing={{nope}}", ctx)).toBe("missing=");
  });
});

describe("ticket-watcher non-status events fire rules", () => {
  let tmpDir: string | null = null;
  let watcher: any = null;

  afterEach(() => {
    if (watcher) {
      try { watcher._setReadTicketOverride(null); } catch {}
      try { watcher._resetDedup(); } catch {}
      if (watcher.isRunning()) watcher.stop();
    }
    watcher = null;
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    tmpDir = null;
  });

  it("ticket:created spawns the configured profile with rendered prompt", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-created-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    // Write an automation.json with a created-event rule.
    const automationPath = path.join(tmpDir, "automation.json");
    fs.writeFileSync(automationPath, JSON.stringify({
      automation: [{
        name: "triage-on-create",
        trigger: { event: "ticket:created" },
        action: { spawnProfile: "triager" },
        promptTemplate: "Triage {{id}} \"{{title}}\" — event={{event}} by {{updatedBy}}",
      }],
    }), "utf8");

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    const core: any = await import("@zana-ai/core");
    const bus = core.events.bus;

    const fakeTicket = {
      id: "T-create-" + Date.now(),
      title: "Investigate latency",
      description: "p99 jumped",
      status: "backlog",
      reviewPhase: null,
      labels: [],
      reworkCount: 0,
    };
    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));

    const captured: any[] = [];
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: (profileId: string, prompt: string, ticketId: string) => {
        captured.push({ profileId, prompt, ticketId });
        return Promise.resolve({ agentId: "fake-triager-1" });
      },
    });

    bus.emit("ticket:created", { ticketId: fakeTicket.id, title: fakeTicket.title, priority: "p1" });

    await new Promise((r) => setTimeout(r, 250));

    expect(captured).toHaveLength(1);
    expect(captured[0].profileId).toBe("triager");
    expect(captured[0].ticketId).toBe(fakeTicket.id);
    // Prompt must include event metadata fed from the bus.
    expect(captured[0].prompt).toContain("event=ticket:created");
    expect(captured[0].prompt).toContain(fakeTicket.id);
    expect(captured[0].prompt).toContain("Investigate latency");

    watcher._setReadTicketOverride(null);
  });

  it("statusChanged template renders {{oldStatus}} and {{newStatus}}", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-status-render-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    const automationPath = path.join(tmpDir, "automation.json");
    fs.writeFileSync(automationPath, JSON.stringify({
      automation: [{
        name: "slack-on-done",
        trigger: { event: "ticket:statusChanged", to: "done" },
        action: { spawnProfile: "slack-notifier" },
        promptTemplate: "{{id}} {{oldStatus}}->{{newStatus}} by {{updatedBy}}",
      }],
    }), "utf8");

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    const core: any = await import("@zana-ai/core");
    const bus = core.events.bus;

    const fakeTicket = {
      id: "T-render-" + Date.now(),
      title: "Demo",
      status: "done",
      reviewPhase: null,
      labels: [],
      reworkCount: 0,
    };
    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));

    const captured: any[] = [];
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: (profileId: string, prompt: string, ticketId: string) => {
        captured.push({ profileId, prompt, ticketId });
        return Promise.resolve({ agentId: "fake-slack-1" });
      },
    });

    bus.emit("ticket:statusChanged", {
      ticketId: fakeTicket.id,
      oldStatus: "review",
      newStatus: "done",
      updatedBy: "alice",
    });

    await new Promise((r) => setTimeout(r, 250));

    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe(`${fakeTicket.id} review->done by alice`);

    watcher._setReadTicketOverride(null);
  });

  it("dedup LRU swallows duplicate emits within 2s", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-dedup-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    const automationPath = path.join(tmpDir, "automation.json");
    fs.writeFileSync(automationPath, JSON.stringify({
      automation: [{
        name: "comment-counter",
        trigger: { event: "ticket:commented" },
        action: { spawnProfile: "noop" },
        promptTemplate: "{{id}}",
      }],
    }), "utf8");

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    const core: any = await import("@zana-ai/core");
    const bus = core.events.bus;

    const fakeTicket = {
      id: "T-dedup-" + Date.now(),
      title: "x",
      status: "in-progress",
      reviewPhase: null,
      labels: [],
      reworkCount: 0,
    };
    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));

    let calls = 0;
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: () => { calls++; return Promise.resolve({ agentId: "fake-noop-" + calls }); },
    });

    // First emit, let the debounce + dispatch run.
    const payload = { ticketId: fakeTicket.id, commentId: "c1", authorId: "alice" };
    bus.emit("ticket:commented", payload);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(1);

    // Second emit with the same dedup key, well past the 150ms debounce
    // but inside the 2s LRU window — should be swallowed by recentlyFired.
    bus.emit("ticket:commented", payload);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(1);

    watcher._setReadTicketOverride(null);
  });
});

describe("ticket-watcher disabled flag", () => {
  it("matchesRule returns false for disabled rules even when trigger matches", async () => {
    const watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const ticket = { status: "review", reviewPhase: "qa", labels: [] };
    const payload = { ticketId: "t1", oldStatus: "in-progress", newStatus: "review", updatedBy: "u" };
    const rule = {
      disabled: true,
      trigger: { event: "ticket:statusChanged", to: "review" },
      action: { spawnProfile: "x" },
    };
    expect(watcher.matchesRule(rule, "ticket:statusChanged", payload, ticket)).toBe(false);

    // Same rule with disabled: false fires.
    expect(watcher.matchesRule(
      { ...rule, disabled: false },
      "ticket:statusChanged",
      payload,
      ticket,
    )).toBe(true);
  });
});

describe("ticket-watcher rule validation", () => {
  let tmpDir: string | null = null;
  let watcher: any = null;

  afterEach(() => {
    if (watcher) {
      try { watcher._setReadTicketOverride(null); } catch {}
      try { watcher._resetDedup(); } catch {}
      if (watcher.isRunning()) watcher.stop();
    }
    watcher = null;
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    tmpDir = null;
  });

  function setup(automation: any) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-validate-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });
    const automationPath = path.join(tmpDir, "automation.json");
    fs.writeFileSync(automationPath, JSON.stringify({ automation }), "utf8");
    return { ticketsDir, automationPath };
  }

  it("flags unknown event names as errors but loads the rules anyway", async () => {
    const { ticketsDir, automationPath } = setup([
      { name: "typo", trigger: { event: "ticket:statusChange" }, action: { spawnProfile: "p" } },
    ]);
    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: () => Promise.resolve({ agentId: "x" }),
    });

    expect(watcher.getRules().length).toBe(1);
    const warnings = watcher.getRuleWarnings();
    const errors = warnings.filter((w: any) => w.level === "error");
    expect(errors.some((e: any) => e.message.includes("unknown event"))).toBe(true);
    expect(errors[0].ruleName).toBe("typo");
  });

  it("flags missing spawnProfile as an error", async () => {
    const { ticketsDir, automationPath } = setup([
      { name: "no-profile", trigger: { event: "ticket:created" }, action: {} },
    ]);
    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: () => Promise.resolve({ agentId: "x" }),
    });
    const warnings = watcher.getRuleWarnings();
    expect(warnings.some((w: any) => w.message.includes("spawnProfile"))).toBe(true);
  });

  it("warns on unknown trigger fields without dropping the rule", async () => {
    const { ticketsDir, automationPath } = setup([
      {
        name: "extra-field",
        trigger: { event: "ticket:statusChanged", to: "done", priority: "high" },
        action: { spawnProfile: "p" },
      },
    ]);
    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: () => Promise.resolve({ agentId: "x" }),
    });
    expect(watcher.getRules().length).toBe(1);
    const warnings = watcher.getRuleWarnings();
    expect(warnings.some((w: any) => w.level === "warn" && w.message.includes("priority"))).toBe(true);
  });

  it("legacy { status, label } shape passes validation cleanly", async () => {
    const { ticketsDir, automationPath } = setup([
      { name: "legacy", trigger: { status: "review", label: "p1" }, action: { spawnProfile: "p" } },
    ]);
    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: () => Promise.resolve({ agentId: "x" }),
    });
    const warnings = watcher.getRuleWarnings();
    const errors = warnings.filter((w: any) => w.level === "error");
    expect(errors).toEqual([]);
  });
});

describe("ticket-watcher hot-reload", () => {
  let tmpDir: string | null = null;
  let watcher: any = null;

  afterEach(() => {
    if (watcher) {
      try { watcher._setReadTicketOverride(null); } catch {}
      try { watcher._resetDedup(); } catch {}
      if (watcher.isRunning()) watcher.stop();
    }
    watcher = null;
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    tmpDir = null;
  });

  function setup(automation: any) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-reload-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });
    const automationPath = path.join(tmpDir, "automation.json");
    fs.writeFileSync(automationPath, JSON.stringify({ automation }), "utf8");
    return { ticketsDir, automationPath };
  }

  it("picks up rule changes when automation.json is overwritten", async () => {
    const { ticketsDir, automationPath } = setup([
      { name: "r1", trigger: { event: "ticket:created" }, action: { spawnProfile: "p1" }, promptTemplate: "{{id}}" },
    ]);

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: () => Promise.resolve({ agentId: "x" }),
    });
    expect(watcher.getRules().length).toBe(1);

    // Wait one poll interval so fs.watchFile establishes a baseline stat.
    await new Promise((r) => setTimeout(r, 250));

    // Overwrite with two rules — the watcher's fs.watchFile + 100ms debounce
    // should reload them within ~400ms.
    fs.writeFileSync(automationPath, JSON.stringify({
      automation: [
        { name: "r1", trigger: { event: "ticket:created" }, action: { spawnProfile: "p1" }, promptTemplate: "{{id}}" },
        { name: "r2", trigger: { event: "ticket:commented" }, action: { spawnProfile: "p2" }, promptTemplate: "{{id}}" },
      ],
    }), "utf8");

    await new Promise((r) => setTimeout(r, 600));
    expect(watcher.getRules().length).toBe(2);
  });

  it("falls back to defaults if the reloaded file is malformed", async () => {
    const { ticketsDir, automationPath } = setup([
      { name: "r1", trigger: { event: "ticket:created" }, action: { spawnProfile: "p1" }, promptTemplate: "{{id}}" },
    ]);

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: () => Promise.resolve({ agentId: "x" }),
    });
    expect(watcher.getRules().length).toBe(1);

    // Wait for baseline stat capture before mutating.
    await new Promise((r) => setTimeout(r, 250));

    // Write garbage — loadRules's catch branch should restore defaults.
    fs.writeFileSync(automationPath, "this is not json {", "utf8");
    await new Promise((r) => setTimeout(r, 600));
    expect(watcher.getRules().length).toBe(3); // DEFAULT_RULES
  });

  it("a rule added post-reload fires when its event is emitted", async () => {
    const { ticketsDir, automationPath } = setup([
      { name: "noop", trigger: { event: "ticket:created" }, action: { spawnProfile: "noop" }, promptTemplate: "{{id}}" },
    ]);

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    const core: any = await import("@zana-ai/core");
    const bus = core.events.bus;

    const fakeTicket = {
      id: "T-reload-" + Date.now(),
      title: "x",
      status: "in-progress",
      reviewPhase: null,
      labels: [],
      reworkCount: 0,
    };
    watcher._setReadTicketOverride((id: string) => (id === fakeTicket.id ? fakeTicket : null));

    const captured: any[] = [];
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: (profileId: string, prompt: string, ticketId: string) => {
        captured.push({ profileId, prompt, ticketId });
        return Promise.resolve({ agentId: "fake-" + captured.length });
      },
    });

    // Wait for baseline stat capture before mutating.
    await new Promise((r) => setTimeout(r, 250));

    // Add a new rule that targets ticket:commented (not in the original config).
    fs.writeFileSync(automationPath, JSON.stringify({
      automation: [
        { name: "noop", trigger: { event: "ticket:created" }, action: { spawnProfile: "noop" }, promptTemplate: "{{id}}" },
        {
          name: "post-reload",
          trigger: { event: "ticket:commented" },
          action: { spawnProfile: "post-reload-profile" },
          promptTemplate: "AFTER RELOAD {{id}}",
        },
      ],
    }), "utf8");

    await new Promise((r) => setTimeout(r, 600)); // wait for reload
    expect(watcher.getRules().length).toBe(2);

    bus.emit("ticket:commented", {
      ticketId: fakeTicket.id,
      commentId: "c1",
      authorId: "alice",
    });
    await new Promise((r) => setTimeout(r, 250));

    expect(captured.some((c) => c.profileId === "post-reload-profile")).toBe(true);
    expect(captured.find((c) => c.profileId === "post-reload-profile").prompt)
      .toBe(`AFTER RELOAD ${fakeTicket.id}`);

    watcher._setReadTicketOverride(null);
  });

  it("stop() releases the file watcher cleanly", async () => {
    const { ticketsDir, automationPath } = setup([
      { name: "r1", trigger: { event: "ticket:created" }, action: { spawnProfile: "p1" }, promptTemplate: "{{id}}" },
    ]);

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: automationPath,
      spawnAgent: () => Promise.resolve({ agentId: "x" }),
    });
    expect(watcher.isRunning()).toBe(true);

    // Wait for baseline stat before stop, so we exercise unwatchFile cleanup.
    await new Promise((r) => setTimeout(r, 250));
    watcher.stop();

    // After stop, edits to automation.json must NOT cause loadRules to fire.
    // We can't observe "no log" directly, but we can confirm the rules array
    // doesn't change when the file does, because the watcher is dead.
    const before = watcher.getRules().length;
    fs.writeFileSync(automationPath, JSON.stringify({
      automation: [
        { name: "r1", trigger: { event: "ticket:created" }, action: { spawnProfile: "p1" }, promptTemplate: "{{id}}" },
        { name: "r2", trigger: { event: "ticket:commented" }, action: { spawnProfile: "p2" }, promptTemplate: "{{id}}" },
      ],
    }), "utf8");
    await new Promise((r) => setTimeout(r, 600));
    expect(watcher.getRules().length).toBe(before);
  });
});
