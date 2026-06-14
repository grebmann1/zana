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

// ── compactInboxFile ──────────────────────────────────────────────────────────
// Compaction is the file-shrinking invariant: the NDJSON inbox grows by one
// append per message + per drain, and compaction rewrites it from scratch so it
// holds ONLY the current in-memory state — one line per surviving message, with
// no historical drain markers or superseded lines.

describe("compactInboxFile", () => {
  it("overwrites the inbox file with only the supplied state, dropping stale history", async () => {
    const p = await loadPersistence();
    const inboxFile = path.join(persistDir, "inboxes.ndjson");

    // Pollute the on-disk file with history: messages, then a drain marker.
    // Pre-compaction the file has 4 lines (3 appends + 1 drain record).
    p.persistInboxMessage("agent-A", { type: "old1" });
    p.persistInboxMessage("agent-A", { type: "old2" });
    p.persistInboxMessage("agent-B", { type: "stale" });
    p.persistInboxDrain("agent-A");
    expect(fs.readFileSync(inboxFile, "utf8").split("\n").filter(Boolean)).toHaveLength(4);

    // Compact to a brand-new, smaller state unrelated to the history above.
    const inboxes = new Map<string, unknown[]>([
      ["agent-A", [{ type: "current" }]],
      ["agent-B", []], // empty inbox contributes no lines
    ]);
    p.compactInboxFile(inboxes);

    // File now holds exactly one line (agent-A's single message); no drain markers.
    const lines = fs.readFileSync(inboxFile, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines.some((l) => l.includes('"drained"'))).toBe(false);

    // And it round-trips back to the compacted state.
    const recovered = p.recoverInboxes();
    expect(recovered.get("agent-A")).toEqual([{ type: "current" }]);
    expect(recovered.has("agent-B")).toBe(false); // no lines ⇒ not present
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

// ── recoverOrphanedAgents ─────────────────────────────────────────────────────
// Crash-recovery on daemon restart: snapshots whose process is still alive are
// re-adopted; those whose process is gone are marked lost+terminated; already
// terminated snapshots are ignored entirely. recoverOrphanedAgents reads the
// raw agents.json array (via recoverAgentSnapshots), so we write that file
// directly — it is the on-disk recovery format and lets us inject a `pid`.

const DEAD_PID = 0x7fffffff; // 2147483647 — no process owns this, kill(0) → ESRCH

function writeSnapshotFile(dir: string, agents: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(agents, null, 2), "utf8");
}

describe("recoverOrphanedAgents", () => {
  it("returns empty adopted/lost arrays when no snapshot file exists", async () => {
    const p = await loadPersistence();
    expect(p.recoverOrphanedAgents()).toEqual({ adopted: [], lost: [] });
  });

  it("re-adopts a snapshot whose process is still alive", async () => {
    // process.pid is guaranteed alive — this very test process owns it.
    writeSnapshotFile(persistDir, [{ id: "live", state: "running", pid: process.pid }]);
    const p = await loadPersistence();

    const { adopted, lost } = p.recoverOrphanedAgents();
    expect(lost).toHaveLength(0);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ id: "live", recoveredState: "re-adopted" });
  });

  it("marks a snapshot whose process is gone as lost + terminated", async () => {
    writeSnapshotFile(persistDir, [{ id: "gone", state: "running", pid: DEAD_PID }]);
    const p = await loadPersistence();

    const { adopted, lost } = p.recoverOrphanedAgents();
    expect(adopted).toHaveLength(0);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ id: "gone", state: "terminated", result: "Lost (daemon restart)" });
    expect(typeof lost[0].terminatedAt).toBe("string");
  });

  it("ignores snapshots already in the terminated state", async () => {
    writeSnapshotFile(persistDir, [{ id: "old", state: "terminated", pid: process.pid }]);
    const p = await loadPersistence();

    const { adopted, lost } = p.recoverOrphanedAgents();
    expect(adopted).toHaveLength(0);
    expect(lost).toHaveLength(0);
  });
});

// ── startPeriodicCompaction / stopPeriodicCompaction ──────────────────────────
// The periodic task wakes every 60s and only rewrites the inbox file when it has
// grown past the size threshold (MAX_INBOX_FILE_LINES * 200 = 1_000_000 bytes),
// pulling current state from the supplied getInboxesFn. stop() must clear the
// interval so no further ticks fire. Fake timers keep this fully deterministic.

const COMPACTION_THRESHOLD = 1_000_000;

describe("startPeriodicCompaction / stopPeriodicCompaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("compacts only when the inbox exceeds the threshold, and stop() halts further ticks", async () => {
    const p = await loadPersistence();
    const inboxFile = path.join(persistDir, "inboxes.ndjson");
    fs.mkdirSync(persistDir, { recursive: true });
    // Oversized file (> 1 MB) so the first tick triggers a compaction.
    fs.writeFileSync(inboxFile, "x".repeat(COMPACTION_THRESHOLD + 1), "utf8");

    const getInboxes = vi.fn(() => new Map([["agent-A", [{ type: "keep" }]]]));
    p.startPeriodicCompaction(getInboxes);

    // First tick: oversized → rewrite from getInboxes(), shrinking the file.
    vi.advanceTimersByTime(60_000);
    expect(getInboxes).toHaveBeenCalledTimes(1);
    expect(fs.statSync(inboxFile).size).toBeLessThan(COMPACTION_THRESHOLD);

    // Second tick: file is now small → no further compaction.
    vi.advanceTimersByTime(60_000);
    expect(getInboxes).toHaveBeenCalledTimes(1);

    // After stop(), even a freshly oversized file is left untouched.
    fs.writeFileSync(inboxFile, "y".repeat(COMPACTION_THRESHOLD + 1), "utf8");
    p.stopPeriodicCompaction();
    vi.advanceTimersByTime(180_000);
    expect(getInboxes).toHaveBeenCalledTimes(1);
    expect(fs.statSync(inboxFile).size).toBeGreaterThan(COMPACTION_THRESHOLD);
  });
});
