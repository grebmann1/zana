import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ─── Phase 1: Guardrails ──────────────────────────────────────────────────────

describe("Phase 1: Guardrails", () => {
  let builtins;

  beforeEach(async () => {
    builtins = (await import("@zana/core/src/guardrails/builtins.ts")).default;
  });

  describe("builtins.jsonParse", () => {
    it("passes valid JSON output", () => {
      const guard = builtins.jsonParse();
      const result = guard.validate('{"key": "value"}');
      expect(result.pass).toBe(true);
      expect(result.parsedOutput).toEqual({ key: "value" });
    });

    it("fails on invalid JSON", () => {
      const guard = builtins.jsonParse();
      const result = guard.validate("not json at all");
      expect(result.pass).toBe(false);
      expect(result.feedback).toContain("valid JSON");
    });

    it("extracts JSON from markdown code fences", () => {
      const guard = builtins.jsonParse();
      const output = 'Here is the result:\n```json\n{"answer": 42}\n```\nDone.';
      const result = guard.validate(output);
      expect(result.pass).toBe(true);
      expect(result.parsedOutput).toEqual({ answer: 42 });
    });
  });

  describe("builtins.noSecrets", () => {
    it("passes clean output", () => {
      const guard = builtins.noSecrets();
      const result = guard.validate("This is a normal response with no secrets.");
      expect(result.pass).toBe(true);
    });

    it("detects AWS keys", () => {
      const guard = builtins.noSecrets();
      const result = guard.validate("Here is the key: AKIAIOSFODNN7EXAMPLE");
      expect(result.pass).toBe(false);
      expect(result.feedback).toBeDefined();
    });

    it("detects private keys", () => {
      const guard = builtins.noSecrets();
      const result = guard.validate("-----BEGIN RSA PRIVATE KEY-----\nblahblah");
      expect(result.pass).toBe(false);
    });
  });

  describe("builtins.maxLength", () => {
    it("passes output under limit", () => {
      const guard = builtins.maxLength(100);
      expect(guard.validate("short").pass).toBe(true);
    });

    it("fails output over limit", () => {
      const guard = builtins.maxLength(5);
      const result = guard.validate("this is too long");
      expect(result.pass).toBe(false);
      expect(result.feedback).toContain("5");
    });
  });

  describe("builtins.fileExists", () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "guardrail-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("passes when file exists", () => {
      const filePath = join(tmpDir, "output.txt");
      require("node:fs").writeFileSync(filePath, "content");
      const guard = builtins.fileExists(filePath);
      expect(guard.validate("").pass).toBe(true);
    });

    it("fails when file does not exist", () => {
      const guard = builtins.fileExists(join(tmpDir, "missing.txt"));
      const result = guard.validate("");
      expect(result.pass).toBe(false);
      expect(result.feedback).toContain("missing.txt");
    });
  });

  describe("builtins.containsPattern", () => {
    it("passes when pattern matches", () => {
      const guard = builtins.containsPattern("function \\w+", "must contain a function declaration");
      expect(guard.validate("function hello() {}").pass).toBe(true);
    });

    it("fails when pattern doesn't match", () => {
      const guard = builtins.containsPattern("class \\w+", "must contain a class");
      const result = guard.validate("const x = 1;");
      expect(result.pass).toBe(false);
      expect(result.feedback).toContain("class");
    });
  });

  describe("resolveGuardrails", () => {
    let guardrails;

    beforeEach(async () => {
      guardrails = await import("@zana/core/src/guardrails/index.ts");
    });

    it("resolves config objects to guardrail instances", () => {
      const configs = [
        { type: "json-parse" },
        { type: "no-secrets" },
        { type: "max-length", maxChars: 500 },
      ];
      const resolved = guardrails.resolveGuardrails(configs);
      expect(resolved).toHaveLength(3);
      expect(resolved[0].id).toBe("json-parse");
      expect(resolved[1].id).toBe("no-secrets");
      expect(resolved[2].id).toBe("max-length");
    });

    it("skips unknown guardrail types", () => {
      const configs = [{ type: "does-not-exist" }];
      const resolved = guardrails.resolveGuardrails(configs);
      expect(resolved).toHaveLength(0);
    });

    it("returns empty for null/empty input", () => {
      expect(guardrails.resolveGuardrails(null)).toEqual([]);
      expect(guardrails.resolveGuardrails([])).toEqual([]);
    });

    it("passes through custom guardrail objects with validate fn", () => {
      const custom = { id: "custom", validate: () => ({ pass: true }) };
      const resolved = guardrails.resolveGuardrails([custom]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("custom");
    });
  });
});

// ─── Phase 2: A2A Typed Messaging + Channels ─────────────────────────────────

describe("Phase 2: A2A Messaging", () => {
  let router;

  beforeEach(async () => {
    router = await import("@zana/core/src/swarm/router.ts");
  });

  describe("typed message routing", () => {
    it("accepts all valid message types", async () => {
      const localAgents = [{ id: "agent-typed", terminalId: "t-typed" }];
      for (const type of ["question", "finding", "handoff", "status", "request"]) {
        const msg = { type, toAgentId: "agent-typed", body: `test-${type}` };
        const result = await router.routeMessage(msg, localAgents, []);
        expect(result.ok).toBe(true);
        expect(result.delivered).toBe("local");
      }
    });

    it("rejects invalid type 'command'", async () => {
      const msg = { type: "command", toAgentId: "x", body: "run it" };
      const result = await router.routeMessage(msg, [], []);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("invalid message type");
    });
  });

  describe("channels", () => {
    it("creates a channel and subscribes agents", () => {
      const sub1 = router.subscribeChannel("test-chan", "agent-a");
      expect(sub1.ok).toBe(true);
      const sub2 = router.subscribeChannel("test-chan", "agent-b");
      expect(sub2.ok).toBe(true);

      const channels = router.listChannels();
      const testChan = channels.find((c) => c.name === "test-chan");
      expect(testChan).toBeDefined();
      expect(testChan.subscribers).toBe(2);
    });

    it("publishes to channel and delivers to subscribers", () => {
      router.subscribeChannel("findings", "sub-1");
      router.subscribeChannel("findings", "sub-2");

      const msg = {
        fromAgentId: "publisher-1",
        type: "finding",
        payload: { kind: "text", content: "Found a bug!" },
      };
      const result = router.publishToChannel("findings", msg);
      expect(result.ok).toBe(true);
      expect(result.delivered).toBe(2);

      const inbox1 = router.peekInbox("sub-1");
      const findingMsg = inbox1.find((m) => m.payload?.content === "Found a bug!");
      expect(findingMsg).toBeDefined();
      expect(findingMsg.channel).toBe("findings");
    });

    it("does not deliver to the sender", () => {
      router.subscribeChannel("echo-chan", "self-sender");
      router.subscribeChannel("echo-chan", "other-agent");

      router.publishToChannel("echo-chan", {
        fromAgentId: "self-sender",
        type: "status",
        payload: { kind: "text", content: "my update" },
      });

      const selfInbox = router.peekInbox("self-sender");
      const selfMsgs = selfInbox.filter((m) => m.channel === "echo-chan" && m.payload?.content === "my update");
      expect(selfMsgs).toHaveLength(0);

      const otherInbox = router.peekInbox("other-agent");
      const otherMsgs = otherInbox.filter((m) => m.channel === "echo-chan" && m.payload?.content === "my update");
      expect(otherMsgs.length).toBeGreaterThanOrEqual(1);
    });

    it("tracks channel history", () => {
      router.subscribeChannel("hist-chan", "hist-agent");
      router.publishToChannel("hist-chan", {
        fromAgentId: "pub-1",
        type: "finding",
        payload: { kind: "text", content: "msg-1" },
      });
      router.publishToChannel("hist-chan", {
        fromAgentId: "pub-1",
        type: "finding",
        payload: { kind: "text", content: "msg-2" },
      });

      const history = router.getChannelHistory("hist-chan");
      expect(history.length).toBeGreaterThanOrEqual(2);

      const limited = router.getChannelHistory("hist-chan", { limit: 1 });
      expect(limited).toHaveLength(1);
      expect(limited[0].payload.content).toBe("msg-2");
    });

    it("unsubscribes agent from channel", () => {
      router.subscribeChannel("unsub-chan", "leaver");
      router.subscribeChannel("unsub-chan", "stayer");
      router.unsubscribeChannel("unsub-chan", "leaver");

      router.publishToChannel("unsub-chan", {
        fromAgentId: "broadcaster",
        type: "status",
        payload: { kind: "text", content: "after unsub" },
      });

      const leaverInbox = router.peekInbox("leaver");
      const afterUnsub = leaverInbox.filter((m) => m.payload?.content === "after unsub");
      expect(afterUnsub).toHaveLength(0);
    });
  });

  describe("acknowledgments", () => {
    it("tracks pending ack", () => {
      const msgId = router.generateMessageId();
      router.requestAck(msgId);
      const ack = router.checkAck(msgId);
      expect(ack).not.toBeNull();
      expect(ack.status).toBe("pending");
    });

    it("records ack response", () => {
      const msgId = router.generateMessageId();
      router.requestAck(msgId);
      const result = router.sendAck(msgId, "agent-x", "completed", "done processing");
      expect(result.ok).toBe(true);

      const ack = router.checkAck(msgId);
      expect(ack.status).toBe("completed");
      expect(ack.agentId).toBe("agent-x");
      expect(ack.response).toBe("done processing");
    });

    it("rejects ack for non-requested message", () => {
      const result = router.sendAck("nonexistent-msg", "a", "received");
      expect(result.ok).toBe(false);
    });

    it("returns null for unknown message", () => {
      expect(router.checkAck("no-such-id")).toBeNull();
    });
  });
});

// ─── Phase 3: Checkpoint Store + Resume ───────────────────────────────────────

describe("Phase 3: Checkpoints", () => {
  let tmpDir;
  let store;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    store = await import("@zana/core/src/runs/checkpoint/store.ts");
    store.init(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("store CRUD", () => {
    it("saves and loads a checkpoint", () => {
      const cp = store.save({
        teamId: "team-1",
        runId: "run-1",
        status: "running",
        completedAgents: [],
        pendingAgents: [],
      });

      expect(cp.id).toBeDefined();
      expect(cp.createdAt).toBeDefined();
      expect(cp.updatedAt).toBeDefined();

      const loaded = store.load(cp.id);
      expect(loaded).not.toBeNull();
      expect(loaded.teamId).toBe("team-1");
      expect(loaded.status).toBe("running");
    });

    it("lists checkpoints with filters", () => {
      store.save({ teamId: "team-a", status: "running" });
      store.save({ teamId: "team-b", status: "completed" });
      store.save({ teamId: "team-a", status: "completed" });

      const all = store.list();
      expect(all.length).toBe(3);

      const teamA = store.list({ teamId: "team-a" });
      expect(teamA.length).toBe(2);

      const completed = store.list({ status: "completed" });
      expect(completed.length).toBe(2);
    });

    it("lists sorted by updatedAt descending", () => {
      // Save cp1, then manually back-date it
      const cp1 = store.save({ teamId: "sort-test", status: "running" });
      // Manually write cp1 with an old updatedAt
      const fs = require("node:fs");
      const path = require("node:path");
      const cp1Data = store.load(cp1.id);
      cp1Data.updatedAt = 1000;
      fs.writeFileSync(path.join(tmpDir, "checkpoints", `${cp1.id}.json`), JSON.stringify(cp1Data));

      const cp2 = store.save({ teamId: "sort-test", status: "running" });

      const list = store.list({ teamId: "sort-test" });
      // cp2 should be first (higher updatedAt)
      expect(list[0].id).toBe(cp2.id);
      expect(list[1].id).toBe(cp1.id);
    });

    it("updates a checkpoint", () => {
      const cp = store.save({ teamId: "t1", status: "running" });
      const updated = store.update(cp.id, { status: "stopped" });
      expect(updated.status).toBe("stopped");
      expect(updated.teamId).toBe("t1");
      expect(updated.id).toBe(cp.id);
    });

    it("removes a checkpoint", () => {
      const cp = store.save({ teamId: "t1" });
      expect(store.remove(cp.id)).toBe(true);
      expect(store.load(cp.id)).toBeNull();
      expect(store.remove(cp.id)).toBe(false);
    });

    it("returns null for non-existent checkpoint", () => {
      expect(store.load("does-not-exist")).toBeNull();
      expect(store.update("does-not-exist", {})).toBeNull();
    });
  });

  describe("agent tracking", () => {
    it("adds completed agent and removes from pending", () => {
      const cp = store.save({
        teamId: "t1",
        status: "running",
        completedAgents: [],
        pendingAgents: [{ agentId: "agent-1", profileId: "coder", prompt: "write code" }],
      });

      const updated = store.addCompletedAgent(cp.id, {
        agentId: "agent-1",
        profileId: "coder",
        profileName: "Coder",
        result: "Done! Wrote the file.",
        exitCode: 0,
      });

      expect(updated.completedAgents).toHaveLength(1);
      expect(updated.completedAgents[0].agentId).toBe("agent-1");
      expect(updated.completedAgents[0].result).toBe("Done! Wrote the file.");
      expect(updated.pendingAgents).toHaveLength(0);
    });

    it("adds pending agent", () => {
      const cp = store.save({ teamId: "t1", status: "running" });

      const updated = store.addPendingAgent(cp.id, {
        profileId: "reviewer",
        prompt: "review the code",
        dependencies: ["agent-1"],
      });

      expect(updated.pendingAgents).toHaveLength(1);
      expect(updated.pendingAgents[0].profileId).toBe("reviewer");
      expect(updated.pendingAgents[0].dependencies).toEqual(["agent-1"]);
    });

    it("returns null when adding to non-existent checkpoint", () => {
      expect(store.addCompletedAgent("fake-id", { agentId: "a" })).toBeNull();
      expect(store.addPendingAgent("fake-id", { profileId: "p", prompt: "x" })).toBeNull();
    });
  });

  describe("resume logic", () => {
    let resumeMod;

    beforeEach(async () => {
      resumeMod = await import("@zana/core/src/runs/checkpoint/resume.ts");
    });

    it("builds context from completed agents", () => {
      const checkpoint = {
        completedAgents: [
          { agentId: "a1", profileName: "Coder", result: "Created main.js" },
          { agentId: "a2", profileName: "Tester", result: "All tests pass" },
        ],
      };
      const pending = { dependencies: ["a1"] };

      const context = resumeMod.buildResumeContext(checkpoint, pending);
      expect(context).toContain("Coder");
      expect(context).toContain("Created main.js");
      expect(context).not.toContain("Tester");
    });

    it("uses all completed agents when no specific dependencies", () => {
      const checkpoint = {
        completedAgents: [
          { agentId: "a1", profileName: "Coder", result: "Built it" },
          { agentId: "a2", profileName: "Tester", result: "Tested it" },
        ],
      };
      const pending = { dependencies: [] };

      const context = resumeMod.buildResumeContext(checkpoint, pending);
      expect(context).toContain("Coder");
      expect(context).toContain("Tester");
    });

    it("enriches prompt with context", () => {
      const prompt = "Review the output";
      const context = "Context from prior steps:\n\nSome context";
      const enriched = resumeMod.enrichPrompt(prompt, context);
      expect(enriched).toContain("Review the output");
      expect(enriched).toContain("Context from prior steps");
    });

    it("returns original prompt when no context", () => {
      expect(resumeMod.enrichPrompt("do it", "")).toBe("do it");
    });

    it("resume returns error for non-existent checkpoint", async () => {
      const mockAM = { spawnHeadlessAgent: () => ({ agentId: "x" }), getAgent: () => null };
      const mockPS = { getProfile: () => null };
      const result = await resumeMod.resume("nonexistent", mockAM, mockPS);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("resume returns error when no pending agents", async () => {
      const cp = store.save({ teamId: "t1", status: "stopped", pendingAgents: [] });
      const mockAM = { spawnHeadlessAgent: () => ({ agentId: "x" }), getAgent: () => null };
      const mockPS = { getProfile: () => null };
      const result = await resumeMod.resume(cp.id, mockAM, mockPS);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("no pending");
    });

    it("resumes by spawning pending agents with enriched prompts", async () => {
      const cp = store.save({
        teamId: "t1",
        status: "stopped",
        completedAgents: [
          { agentId: "done-1", profileId: "coder", profileName: "Coder", result: "Built feature X" },
        ],
        pendingAgents: [
          { profileId: "reviewer", prompt: "Review the code", dependencies: ["done-1"] },
        ],
      });

      const spawned = [];
      const mockAM = {
        spawnHeadlessAgent: (profile, opts) => {
          const id = `mock-${spawned.length}`;
          spawned.push({ id, profile, opts });
          return { agentId: id };
        },
        getAgent: () => null,
      };
      const mockPS = {
        getProfile: (id) => ({ id, displayName: id, icon: "🤖" }),
      };

      const result = await resumeMod.resume(cp.id, mockAM, mockPS);
      expect(result.ok).toBe(true);
      expect(result.spawned).toHaveLength(1);
      expect(result.spawned[0].profileId).toBe("reviewer");

      // Verify the prompt was enriched with context
      expect(spawned[0].opts.prompt).toContain("Review the code");
      expect(spawned[0].opts.prompt).toContain("Coder");
      expect(spawned[0].opts.prompt).toContain("Built feature X");

      // Verify checkpoint was updated
      const updated = store.load(cp.id);
      expect(updated.status).toBe("running");
      expect(updated.resumeRunId).toBeDefined();
    });

    it("handles missing profiles gracefully during resume", async () => {
      const cp = store.save({
        teamId: "t1",
        status: "stopped",
        pendingAgents: [
          { profileId: "deleted-profile", prompt: "do something" },
        ],
      });

      const mockAM = { spawnHeadlessAgent: () => ({ agentId: "x" }), getAgent: () => null };
      const mockPS = { getProfile: () => null };

      const result = await resumeMod.resume(cp.id, mockAM, mockPS);
      expect(result.ok).toBe(true);
      expect(result.spawned[0].error).toContain("not found");
    });
  });
});

// ─── Integration: Full Flow ───────────────────────────────────────────────────

describe("Integration: guardrail → channel → checkpoint flow", () => {
  let router;
  let store;
  let guardrails;
  let resumeMod;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "integration-test-"));
    router = await import("@zana/core/src/swarm/router.ts");
    store = await import("@zana/core/src/runs/checkpoint/store.ts");
    guardrails = await import("@zana/core/src/guardrails/index.ts");
    resumeMod = await import("@zana/core/src/runs/checkpoint/resume.ts");
    store.init(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("simulates a full team run lifecycle", async () => {
    // 1. Create checkpoint for team run
    const cp = store.save({
      teamId: "integration-team",
      teamName: "Test Team",
      runId: "run-1",
      status: "running",
      completedAgents: [],
      pendingAgents: [],
    });
    expect(cp.id).toBeDefined();

    // 2. Set up a "findings" channel
    router.subscribeChannel("findings", "agent-reviewer");

    // 3. Simulate worker completing and publishing to channel
    store.addCompletedAgent(cp.id, {
      agentId: "worker-1",
      profileId: "coder",
      profileName: "Coder",
      result: '{"files": ["src/app.ts"], "linesChanged": 42}',
      exitCode: 0,
    });

    router.publishToChannel("findings", {
      fromAgentId: "worker-1",
      type: "finding",
      payload: { kind: "structured", data: { files: ["src/app.ts"], linesChanged: 42 } },
    });

    // 4. Verify channel delivery
    const inbox = router.peekInbox("agent-reviewer");
    const finding = inbox.find((m) => m.channel === "findings");
    expect(finding).toBeDefined();
    expect(finding.payload.data.linesChanged).toBe(42);

    // 5. Validate the output with a guardrail
    const resolved = guardrails.resolveGuardrails([{ type: "json-parse" }]);
    const check = resolved[0].validate('{"files": ["src/app.ts"], "linesChanged": 42}');
    expect(check.pass).toBe(true);
    expect(check.parsedOutput.files).toEqual(["src/app.ts"]);

    // 6. Add a pending agent that depends on worker-1
    store.addPendingAgent(cp.id, {
      profileId: "reviewer",
      prompt: "Review the changes",
      dependencies: ["worker-1"],
    });

    // 7. Simulate team stop
    store.update(cp.id, { status: "stopped" });

    // 8. Resume from checkpoint
    const spawned = [];
    const mockAM = {
      spawnHeadlessAgent: (profile, opts) => {
        const id = `resumed-${spawned.length}`;
        spawned.push({ id, profile, opts });
        return { agentId: id };
      },
      getAgent: () => null,
    };
    const mockPS = {
      getProfile: (id) => ({ id, displayName: id, icon: "🤖" }),
    };

    const result = await resumeMod.resume(cp.id, mockAM, mockPS);
    expect(result.ok).toBe(true);
    expect(result.spawned).toHaveLength(1);

    // 9. Verify resumed agent got context from completed worker
    const resumedPrompt = spawned[0].opts.prompt;
    expect(resumedPrompt).toContain("Review the changes");
    expect(resumedPrompt).toContain("Coder");
    expect(resumedPrompt).toContain("linesChanged");

    // 10. Verify checkpoint state
    const final = store.load(cp.id);
    expect(final.status).toBe("running");
    expect(final.completedAgents).toHaveLength(1);
    expect(final.resumeRunId).toBeDefined();
  });
});
