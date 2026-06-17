// Unit tests for ADR 0006 daemon-forwarding client. Covers: the forwardable
// action set, the action→HTTP-endpoint mapping (fetch mocked), auth-token
// reading, and the auth-vs-unreachable error classification that decides
// whether the caller falls back to in-process (unreachable) or surfaces the
// error (auth — must NOT silently re-fragment).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isForwardable,
  forwardToDaemon,
  authorityPortFor,
  FORWARDED_ACTIONS,
  DaemonAuthError,
  DaemonUnreachableError,
} from "@zana-ai/mcp/src/daemon-client.ts";

// Point HOME at a tmp dir so readAuthToken reads our fixture, not the real one.
let tmpHome: string;
let origHome: string | undefined;
let origFetch: any;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zana-daemon-client-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, ".zana"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, ".zana", "auth.json"),
    JSON.stringify({ token: "test-token-abc", createdAt: 1 }),
    "utf8",
  );
  origFetch = globalThis.fetch;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  globalThis.fetch = origFetch;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function mockFetch(impl: (url: string, init: any) => { status: number; body: string }) {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const { status, body } = impl(String(url), init);
    return {
      status,
      text: async () => body,
    } as any;
  }) as any;
}

describe("isForwardable / FORWARDED_ACTIONS", () => {
  it("forwards the lifecycle actions and nothing else", () => {
    for (const a of ["spawn_agent", "spawn_agent_validated", "spawn_oneshot", "list_agents", "agent_status", "agent_result", "kill_agent"]) {
      expect(isForwardable(a)).toBe(true);
    }
    // file/DB-backed domains stay in-process
    for (const a of ["ticket_create", "ticket_update", "artifact_create", "schedule_create", "memory_store", "deliberate"]) {
      expect(isForwardable(a)).toBe(false);
    }
    expect(FORWARDED_ACTIONS.size).toBe(7);
  });
});

describe("authorityPortFor — forwarding decision (ADR 0006)", () => {
  const SELF = 5000;
  it("forwards to a SEPARATE daemon that has an apiPort", () => {
    expect(authorityPortFor({ apiPort: 47401, pid: 6000 }, SELF)).toBe(47401);
  });
  it("does NOT forward to our own in-process core (no apiPort)", () => {
    expect(authorityPortFor({ pid: 6000 }, SELF)).toBeNull();
  });
  it("does NOT forward to ourselves (same pid), even with an apiPort", () => {
    expect(authorityPortFor({ apiPort: 47401, pid: SELF }, SELF)).toBeNull();
  });
  it("returns null when there is no daemon entry", () => {
    expect(authorityPortFor(null, SELF)).toBeNull();
    expect(authorityPortFor(undefined, SELF)).toBeNull();
  });
});

describe("forwardToDaemon — action → HTTP endpoint mapping", () => {
  it("spawn_agent → POST /agents with profileId/prompt/cwd + Bearer token", async () => {
    let seen: any = null;
    mockFetch((url, init) => { seen = { url, init }; return { status: 201, body: JSON.stringify({ agentId: "a1" }) }; });
    const out = await forwardToDaemon(47401, "spawn_agent", { profileId: "coder", prompt: "go", cwd: "/ws" });
    expect(out).toEqual({ agentId: "a1" });
    expect(seen.url).toBe("http://127.0.0.1:47401/agents");
    expect(seen.init.method).toBe("POST");
    expect(seen.init.headers.authorization).toBe("Bearer test-token-abc");
    expect(JSON.parse(seen.init.body)).toEqual({ profileId: "coder", prompt: "go", cwd: "/ws" });
  });

  it("list_agents → GET /agents", async () => {
    let seen: any = null;
    mockFetch((url, init) => { seen = { url, method: init.method }; return { status: 200, body: "[]" }; });
    await forwardToDaemon(47401, "list_agents", {});
    expect(seen).toEqual({ url: "http://127.0.0.1:47401/agents", method: "GET" });
  });

  it("agent_status → GET /agents/:id (id encoded)", async () => {
    let seen: any = null;
    mockFetch((url, init) => { seen = url; return { status: 200, body: "{}" }; });
    await forwardToDaemon(47401, "agent_status", { agentId: "a b/c" });
    expect(seen).toBe("http://127.0.0.1:47401/agents/a%20b%2Fc");
  });

  it("agent_result → GET /agents/:id/result", async () => {
    let seen: any = null;
    mockFetch((url) => { seen = url; return { status: 200, body: "{}" }; });
    await forwardToDaemon(47401, "agent_result", { agentId: "a1" });
    expect(seen).toBe("http://127.0.0.1:47401/agents/a1/result");
  });

  it("kill_agent → DELETE /agents/:id", async () => {
    let seen: any = null;
    mockFetch((url, init) => { seen = { url, method: init.method }; return { status: 200, body: '{"ok":true}' }; });
    const out = await forwardToDaemon(47401, "kill_agent", { agentId: "a1" });
    expect(out).toEqual({ ok: true });
    expect(seen).toEqual({ url: "http://127.0.0.1:47401/agents/a1", method: "DELETE" });
  });
});

describe("forwardToDaemon — error classification (ADR 0006)", () => {
  it("throws DaemonAuthError on 401 (caller must NOT fall back)", async () => {
    mockFetch(() => ({ status: 401, body: "" }));
    await expect(forwardToDaemon(47401, "list_agents", {})).rejects.toBeInstanceOf(DaemonAuthError);
  });

  it("throws DaemonAuthError on 403", async () => {
    mockFetch(() => ({ status: 403, body: "" }));
    await expect(forwardToDaemon(47401, "list_agents", {})).rejects.toBeInstanceOf(DaemonAuthError);
  });

  it("throws DaemonUnreachableError when fetch rejects (daemon down → caller falls back)", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as any;
    await expect(forwardToDaemon(47401, "list_agents", {})).rejects.toBeInstanceOf(DaemonUnreachableError);
  });

  it("throws DaemonUnreachableError when no auth token file exists", async () => {
    fs.rmSync(path.join(tmpHome, ".zana", "auth.json"));
    await expect(forwardToDaemon(47401, "list_agents", {})).rejects.toBeInstanceOf(DaemonUnreachableError);
  });
});
