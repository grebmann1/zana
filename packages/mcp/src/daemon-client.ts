// ADR 0006 — daemon agent-registry forwarding.
//
// When a standalone HTTP daemon is running for the same workspace, the MCP
// server forwards agent-LIFECYCLE actions (spawn/list/status/result/kill) to
// it over the authenticated HTTP API, so that daemon is the single authority
// for live agent state. When no such daemon exists, the caller falls back to
// the MCP server's own in-process core (see mcp-server.ts callCore).
//
// This module is just the HTTP client + the action→endpoint mapping. The
// decision of WHEN to forward lives in mcp-server.ts (resolveAgentAuthority).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// The daemon auth token is the host-global token the API server reads/creates
// at ~/.zana/auth.json (packages/server/src/api/auth-middleware.ts). Any process
// on the host can read it to authenticate — that's how a sibling MCP server
// reaches a daemon it didn't start. Resolves ADR 0006's one open item.
function readAuthToken(): string | null {
  const authFile = path.join(
    process.env.HOME || process.env.USERPROFILE || os.homedir(),
    ".zana",
    "auth.json",
  );
  try {
    const raw = JSON.parse(fs.readFileSync(authFile, "utf8"));
    return typeof raw.token === "string" && raw.token.length > 0 ? raw.token : null;
  } catch {
    return null;
  }
}

// The lifecycle actions that forward to the daemon. Everything else
// (tickets/artifacts/schedules/memory) is file/DB-backed and stays in-process.
export const FORWARDED_ACTIONS: ReadonlySet<string> = new Set([
  "spawn_agent",
  "spawn_agent_validated",
  "spawn_oneshot",
  "list_agents",
  "agent_status",
  "agent_result",
  "kill_agent",
]);

export function isForwardable(action: string): boolean {
  return FORWARDED_ACTIONS.has(action);
}

// Decide whether a registry entry is a forwarding target: a SEPARATE, alive
// daemon that serves an HTTP API. We must NOT forward to our own in-process
// core (it boots with skipApiServer:true → no apiPort) nor to our own pid.
// Returns the apiPort to forward to, or null to use in-process core. Pure (the
// caller supplies the entry + self pid) so it's unit-testable without a registry.
export function authorityPortFor(
  entry: { apiPort?: number; pid?: number } | null | undefined,
  selfPid: number,
): number | null {
  if (!entry) return null;
  if (!entry.apiPort) return null;        // in-process core has no API server
  if (entry.pid === selfPid) return null; // never forward to ourselves
  return entry.apiPort;
}

// Distinguish a transport/connection failure (daemon went away → safe to fall
// back to in-process) from an AUTH failure (401 → surface, do NOT silently
// re-fragment by falling back, per ADR 0006).
export class DaemonAuthError extends Error {
  constructor(msg: string) { super(msg); this.name = "DaemonAuthError"; }
}
export class DaemonUnreachableError extends Error {
  constructor(msg: string) { super(msg); this.name = "DaemonUnreachableError"; }
}

async function httpJson(
  method: string,
  apiPort: number,
  pathname: string,
  body?: unknown,
): Promise<any> {
  const token = readAuthToken();
  if (!token) {
    // No token file → cannot authenticate. Treat as unreachable (fall back to
    // in-process) rather than auth error: a fresh daemon writes the file on
    // boot, so a missing file usually means no real daemon to talk to.
    throw new DaemonUnreachableError("no daemon auth token (~/.zana/auth.json)");
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
      method,
      headers: {
        "authorization": `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    throw new DaemonUnreachableError(`daemon connect failed: ${err?.message || err}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new DaemonAuthError(`daemon rejected auth (${res.status}) — token mismatch`);
  }
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

// Map a lifecycle action + params to the daemon's HTTP API and return its JSON.
// Endpoints: POST /agents (spawn), GET /agents (list), GET /agents/:id (status),
// GET /agents/:id/result, DELETE /agents/:id (kill). See server/src/api/server.ts.
export async function forwardToDaemon(
  apiPort: number,
  action: string,
  params: Record<string, any>,
): Promise<any> {
  switch (action) {
    case "spawn_agent":
    case "spawn_agent_validated":
    case "spawn_oneshot": {
      // The HTTP spawn endpoint takes { profileId, prompt, cwd } and returns the
      // created agent record. (validated/oneshot collapse to the same endpoint;
      // the daemon owns the live process either way.)
      return httpJson("POST", apiPort, "/agents", {
        profileId: params.profileId,
        prompt: params.prompt,
        cwd: params.cwd,
      });
    }
    case "list_agents":
      return httpJson("GET", apiPort, "/agents");
    case "agent_status":
      return httpJson("GET", apiPort, `/agents/${encodeURIComponent(params.agentId)}`);
    case "agent_result":
      return httpJson("GET", apiPort, `/agents/${encodeURIComponent(params.agentId)}/result`);
    case "kill_agent":
      return httpJson("DELETE", apiPort, `/agents/${encodeURIComponent(params.agentId)}`);
    default:
      // Should never happen — isForwardable() gates this.
      throw new Error(`forwardToDaemon: action not forwardable: ${action}`);
  }
}
