import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PERSIST_DIR = path.join(os.homedir(), ".zana", "persistence");
const INBOX_FILE = path.join(PERSIST_DIR, "inboxes.ndjson");
const AGENTS_FILE = path.join(PERSIST_DIR, "agents.json");

import * as persistence from "@zana/core/src/persistence.ts";

// Use a unique prefix so tests don't collide with real data
const testAgentId = `test-agent-${Date.now()}`;

describe("persistence", () => {
  describe("inbox persistence", () => {
    beforeEach(() => {
      persistence.clearInboxFile();
    });

    afterEach(() => {
      persistence.clearInboxFile();
    });

    it("persists and recovers a message", () => {
      const msg = { id: "msg-1", body: "hello", type: "question", sentAt: Date.now() };
      persistence.persistInboxMessage(testAgentId, msg);

      const recovered = persistence.recoverInboxes();
      expect(recovered.has(testAgentId)).toBe(true);
      expect(recovered.get(testAgentId)).toHaveLength(1);
      expect(recovered.get(testAgentId)[0].body).toBe("hello");
    });

    it("recovers multiple messages for same agent", () => {
      persistence.persistInboxMessage(testAgentId, { id: "m1", body: "one" });
      persistence.persistInboxMessage(testAgentId, { id: "m2", body: "two" });

      const recovered = persistence.recoverInboxes();
      expect(recovered.get(testAgentId)).toHaveLength(2);
    });

    it("drain clears recovered inbox", () => {
      persistence.persistInboxMessage(testAgentId, { id: "m1", body: "msg" });
      persistence.persistInboxDrain(testAgentId);

      const recovered = persistence.recoverInboxes();
      expect(recovered.get(testAgentId) || []).toHaveLength(0);
    });

    it("recovers empty when no file exists", () => {
      persistence.clearInboxFile();
      const recovered = persistence.recoverInboxes();
      expect(recovered.size).toBe(0);
    });
  });

  describe("agent snapshots", () => {
    beforeEach(() => {
      persistence.clearAgentSnapshots();
    });

    afterEach(() => {
      persistence.clearAgentSnapshots();
    });

    it("snapshots and recovers agents", () => {
      const agents = [
        { id: "a1", profileId: "p1", profileName: "Test", terminalId: "t1", mode: "headless", state: "active", spawnedAt: 1000, lastActivity: 2000, lastAction: "running", result: null },
        { id: "a2", profileId: "p2", profileName: "Worker", terminalId: "t2", mode: "headless", state: "terminated", spawnedAt: 500, lastActivity: 1500, lastAction: "done", result: "success" },
      ];
      persistence.snapshotAgents(agents);

      const recovered = persistence.recoverAgentSnapshots();
      expect(recovered).toHaveLength(2);
      expect(recovered[0].id).toBe("a1");
      expect(recovered[1].result).toBe("success");
    });

    it("returns empty array when no snapshot exists", () => {
      const recovered = persistence.recoverAgentSnapshots();
      expect(recovered).toEqual([]);
    });
  });
});
