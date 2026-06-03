/**
 * Tests for packages/core/src/persistence.ts
 *
 * Strategy: the module uses module-level path constants computed from
 * PERSIST_DIR (a getter on config). We redirect those paths to a temp dir by
 * doMock-ing the config module before each fresh import of persistence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let persistDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-persist-test-"));
  persistDir = path.join(tmpDir, "persistence");

  vi.resetModules();

  // Redirect PERSIST_DIR to the temp directory BEFORE persistence.ts is imported.
  vi.doMock("../src/config.ts", () => ({
    default: { PERSIST_DIR: persistDir },
    PERSIST_DIR: persistDir,
  }));
});

afterEach(() => {
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadPersistence() {
  return await import("../src/persistence.ts");
}

// ── recoverInboxes ────────────────────────────────────────────────────────────

describe("recoverInboxes", () => {
  it("returns an empty Map when the inbox file does not exist", async () => {
    const p = await loadPersistence();
    const result = p.recoverInboxes();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("replays persisted messages for each agent", async () => {
    const p = await loadPersistence();
    p.persistInboxMessage("agent-A", { type: "ping" });
    p.persistInboxMessage("agent-A", { type: "pong" });
    p.persistInboxMessage("agent-B", { type: "hello" });

    const result = p.recoverInboxes();
    expect(result.get("agent-A")).toHaveLength(2);
    expect(result.get("agent-B")).toHaveLength(1);
    expect(result.get("agent-A")![0]).toMatchObject({ type: "ping" });
  });

  it("drain record clears prior messages for that agent only", async () => {
    const p = await loadPersistence();
    p.persistInboxMessage("agent-A", { type: "msg1" });
    p.persistInboxMessage("agent-A", { type: "msg2" });
    p.persistInboxDrain("agent-A");
    p.persistInboxMessage("agent-A", { type: "msg3" }); // after drain

    const result = p.recoverInboxes();
    // Only msg3 (post-drain) should survive
    expect(result.get("agent-A")).toEqual([{ type: "msg3" }]);
  });

  it("preserves messages from other agents across a drain of one agent", async () => {
    const p = await loadPersistence();
    p.persistInboxMessage("agent-X", { type: "keep-me" });
    p.persistInboxMessage("agent-Y", { type: "will-drain" });
    p.persistInboxDrain("agent-Y");

    const result = p.recoverInboxes();
    expect(result.get("agent-X")).toHaveLength(1);
    expect(result.get("agent-Y")).toEqual([]);
  });

  it("tolerates malformed NDJSON lines without throwing", async () => {
    const p = await loadPersistence();
    // Inject a malformed line manually into the inbox file
    fs.mkdirSync(persistDir, { recursive: true });
    const inboxFile = path.join(persistDir, "inboxes.ndjson");
    fs.writeFileSync(
      inboxFile,
      'not-json\n{"agentId":"agent-X","msg":{"type":"ok"},"ts":1}\n',
      "utf8"
    );

    const result = p.recoverInboxes();
    expect(result.get("agent-X")).toEqual([{ type: "ok" }]);
  });
});

// ── snapshotAgents / recoverAgentSnapshots ────────────────────────────────────

describe("snapshotAgents + recoverAgentSnapshots", () => {
  it("round-trips agent data correctly", async () => {
    const p = await loadPersistence();
    const agents = [
      {
        id: "a1",
        profileId: "prof-1",
        profileName: "researcher",
        terminalId: "t1",
        mode: "auto",
        state: "running",
        spawnedAt: "2026-01-01T00:00:00Z",
        lastActivity: "2026-01-01T01:00:00Z",
        lastAction: "thinking",
        result: null,
        parentAgentId: null,
      },
    ];
    p.snapshotAgents(agents);
    const recovered = p.recoverAgentSnapshots();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: "a1", profileName: "researcher", state: "running" });
  });

  it("returns empty array when snapshot file does not exist", async () => {
    const p = await loadPersistence();
    const result = p.recoverAgentSnapshots();
    expect(result).toEqual([]);
  });

  it("omits parentAgentId when undefined on the source agent", async () => {
    const p = await loadPersistence();
    const agent = {
      id: "a2",
      profileId: "p",
      profileName: "worker",
      terminalId: "t2",
      mode: "auto",
      state: "idle",
      spawnedAt: "",
      lastActivity: "",
      lastAction: null,
      result: null,
      // parentAgentId intentionally omitted
    };
    p.snapshotAgents([agent]);
    const [snap] = p.recoverAgentSnapshots();
    expect(snap.parentAgentId).toBeNull();
  });
});

// ── persistChannelMessage / recoverChannels ───────────────────────────────────

describe("persistChannelMessage + recoverChannels", () => {
  it("recovers messages grouped by channel name", async () => {
    const p = await loadPersistence();
    p.persistChannelMessage("general", { text: "hello" });
    p.persistChannelMessage("general", { text: "world" });
    p.persistChannelMessage("ops", { text: "alert" });

    const channels = p.recoverChannels();
    expect(channels.get("general")).toHaveLength(2);
    expect(channels.get("ops")).toHaveLength(1);
    expect(channels.get("general")![0]).toMatchObject({ text: "hello" });
  });

  it("strips unsafe characters from channel names (sanitization)", async () => {
    const p = await loadPersistence();
    // Channel name with path traversal characters
    p.persistChannelMessage("../evil/../etc", { text: "x" });
    const channels = p.recoverChannels();
    for (const key of channels.keys()) {
      expect(key).not.toContain("/");
      expect(key).not.toContain(".");
    }
  });

  it("returns empty Map when no channel files exist", async () => {
    const p = await loadPersistence();
    const channels = p.recoverChannels();
    expect(channels).toBeInstanceOf(Map);
    expect(channels.size).toBe(0);
  });
});
