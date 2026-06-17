/**
 * Tests for the clear* helpers in packages/core/src/persistence.ts
 *
 * clearInboxFile() and clearAgentSnapshots() are the on-disk reset paths used
 * when daemon state is intentionally wiped. They were the only exported
 * persistence functions with no coverage. Both:
 *   - delete their backing file so the corresponding recover* call returns empty
 *   - are idempotent: deleting a file that does not exist must NOT throw
 *     (the unlink is wrapped in a swallowing try/catch)
 *
 * Strategy mirrors persistence.test.ts: redirect PERSIST_DIR to a temp dir via
 * doMock BEFORE persistence.ts is imported, then exercise the real fs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let persistDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-persist-clear-test-"));
  persistDir = path.join(tmpDir, "persistence");

  vi.resetModules();
  vi.doMock("@zana-ai/contracts", () => ({
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

describe("clearInboxFile", () => {
  it("deletes the inbox file so recovery returns an empty Map", async () => {
    const p = await loadPersistence();
    const inboxFile = path.join(persistDir, "inboxes.ndjson");

    p.persistInboxMessage("agent-A", { type: "ping" });
    expect(fs.existsSync(inboxFile)).toBe(true);
    expect(p.recoverInboxes().size).toBe(1);

    p.clearInboxFile();

    expect(fs.existsSync(inboxFile)).toBe(false);
    expect(p.recoverInboxes().size).toBe(0);
  });

  it("is idempotent — does not throw when the inbox file is absent", async () => {
    const p = await loadPersistence();
    // No file was ever written; clearing twice must stay silent.
    expect(() => {
      p.clearInboxFile();
      p.clearInboxFile();
    }).not.toThrow();
  });
});

describe("clearAgentSnapshots", () => {
  it("deletes the snapshot file so recovery returns an empty array", async () => {
    const p = await loadPersistence();
    const agentsFile = path.join(persistDir, "agents.json");

    p.snapshotAgents([
      {
        id: "a1",
        profileId: "p",
        profileName: "worker",
        terminalId: "t1",
        mode: "auto",
        state: "running",
        spawnedAt: "",
        lastActivity: "",
        lastAction: null,
        result: null,
      },
    ]);
    expect(fs.existsSync(agentsFile)).toBe(true);
    expect(p.recoverAgentSnapshots()).toHaveLength(1);

    p.clearAgentSnapshots();

    expect(fs.existsSync(agentsFile)).toBe(false);
    expect(p.recoverAgentSnapshots()).toEqual([]);
  });

  it("is idempotent — does not throw when the snapshot file is absent", async () => {
    const p = await loadPersistence();
    expect(() => {
      p.clearAgentSnapshots();
      p.clearAgentSnapshots();
    }).not.toThrow();
  });
});
