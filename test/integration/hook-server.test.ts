import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { startHookServer, setHivemindModules } from "@zana/core/src/hook-server.ts";

let server;
let port;

// Mock hivemind modules
const mockRouter = {
  deliverLocal(agentId, msg) {},
  drainInbox(agentId) { return [{ id: "msg1", body: "test" }]; },
  peekInbox(agentId) { return []; },
};
const mockEvents = {
  addEvent(event) {},
};
const mockGetAgents = () => [
  { id: "a1", terminalId: "t1", profileName: "Test", profileIcon: "🤖", state: "active", mode: "headless" },
];

beforeAll(async () => {
  setHivemindModules({ router: mockRouter, events: mockEvents, getAgents: mockGetAgents });
  server = await startHookServer(() => {}, async () => ({ ok: true }), 47900);
  port = server.port;
});

afterAll(() => {
  server?.stop();
});

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", timeout: 3000 }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1", port, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 3000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("hook-server", () => {
  it("starts and listens on a port", () => {
    expect(port).toBeGreaterThan(0);
  });

  describe("GET /hivemind/agents", () => {
    it("returns active agents", async () => {
      const res = await httpGet("/hivemind/agents");
      expect(res.status).toBe(200);
      const agents = JSON.parse(res.body);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("a1");
      expect(agents[0].profileName).toBe("Test");
    });
  });

  describe("GET /hivemind/inbox", () => {
    it("rejects missing agentId", async () => {
      const res = await httpGet("/hivemind/inbox");
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("agentId required");
    });

    it("rejects invalid agentId format", async () => {
      const res = await httpGet("/hivemind/inbox?agentId=../../etc/passwd");
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("invalid agentId format");
    });

    it("accepts valid agentId with drain", async () => {
      const res = await httpGet("/hivemind/inbox?agentId=valid-agent-123&drain=true");
      expect(res.status).toBe(200);
      const messages = JSON.parse(res.body);
      expect(Array.isArray(messages)).toBe(true);
    });
  });

  describe("POST /hivemind/inbox", () => {
    it("delivers a message", async () => {
      const res = await httpPost("/hivemind/inbox", {
        toAgentId: "agent-1",
        body: "hello",
        type: "question",
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
    });

    it("rejects missing toAgentId", async () => {
      const res = await httpPost("/hivemind/inbox", { body: "hello" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /hivemind/events", () => {
    it("accepts an event", async () => {
      const res = await httpPost("/hivemind/events", {
        type: "progress",
        summary: "working",
        hiveId: "sub-1",
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
    });
  });

  describe("POST /hook", () => {
    it("returns 204 on valid hook payload", async () => {
      const res = await httpPost("/hook", { hook_event_name: "PreToolUse", tool_name: "Read" });
      expect(res.status).toBe(204);
    });
  });

  describe("POST /orchestrator", () => {
    it("returns orchestrator result", async () => {
      const res = await httpPost("/orchestrator", { action: "list_agents" });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
    });
  });

  describe("unknown routes", () => {
    it("returns 404 for unknown GET", async () => {
      const res = await httpGet("/unknown");
      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown POST", async () => {
      const res = await httpPost("/unknown", {});
      expect(res.status).toBe(404);
    });
  });

  describe("invalid JSON", () => {
    it("returns 400 on malformed body", async () => {
      return new Promise((resolve, reject) => {
        const data = "not json{{{";
        const req = http.request({
          hostname: "127.0.0.1", port, path: "/hook", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          timeout: 3000,
        }, (res) => {
          let buf = "";
          res.on("data", (c) => { buf += c; });
          res.on("end", () => {
            expect(res.statusCode).toBe(400);
            resolve();
          });
        });
        req.on("error", reject);
        req.write(data);
        req.end();
      });
    });
  });
});
