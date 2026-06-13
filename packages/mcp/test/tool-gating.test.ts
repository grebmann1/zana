// Verifies the ZANA_DAEMON_TOOLS gate (and ZANA_MASTER_MODE swarm gate) on
// the MCP server's tools/list response.
//
// Strategy: drive the compiled dist binary over stdio JSON-RPC, run the
// initialize handshake, then call tools/list and assert tool counts and
// per-tool presence under each env-flag combination. Same subprocess pattern
// as mcp-server.test.ts — see that file for the rationale.

import { describe, it, expect } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const SERVER_PATH = path.resolve(__dirname, "../dist/src/mcp-server.js");

// All names DAEMON_GATED_TOOL_NAMES filters out when the gate is closed.
const DAEMON_GATED = [
  "zana_spawn_agent",
  "zana_spawn_agent_validated",
  "zana_oneshot_query",
  "zana_list_agents",
  "zana_agent_status",
  "zana_agent_result",
  "zana_kill_agent",
  "zana_start_team",
  "zana_stop_team",
  "zana_team_status",
  "zana_list_running_teams",
  "zana_ask_agent",
  "zana_check_inbox",
  "zana_send_ack",
  "zana_autopilot_goal_driven",
  "zana_autopilot_goal_status",
  "zana_autopilot_goal_list",
  "zana_autopilot_goal_cancel",
  "zana_deliberate",
  "zana_deliberate_cancel",
  "zana_deliberation_status",
  "zana_deliberation_list",
  "zana_deliberation_nudge",
  "zana_deliberation_override",
];

const SWARM_GATED = [
  "zana_swarm_spawn",
  "zana_swarm_list",
  "zana_swarm_instruct",
  "zana_swarm_stop",
  "zana_swarm_broadcast",
  "zana_swarm_poll_events",
];

// Read newline-delimited JSON-RPC frames until we get the response with the
// requested id. Some responses (e.g. tools/list with the full surface) are
// larger than a single chunk, so we accumulate until we see a parseable line.
function rpcCall(
  proc: ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params: unknown,
  timeoutMs = 8000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${method} response`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(t);
            proc.stdout.off("data", onData);
            resolve(msg);
            return;
          }
        } catch {
          // Ignore non-JSON noise (server shouldn't emit any to stdout, but
          // be defensive).
        }
      }
    };

    proc.stdout.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });

    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function spawnServer(tmpDir: string, extraEnv: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  return spawn("node", [SERVER_PATH], {
    env: {
      ...process.env,
      ZANA_AUTO_INIT: "0",
      ZANA_TERMINAL_ID: "mcp-gating-test",
      ZANA_WORKSPACE: tmpDir,
      ZANA_SKIP_MCP_INSTALL: "1",
      // Intentionally unset by default — individual tests opt in.
      ZANA_DAEMON_TOOLS: "",
      ZANA_MASTER_MODE: "",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

async function listTools(
  extraEnv: Record<string, string>,
  rpcTimeoutMs = 10000,
): Promise<string[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-mcp-gating-"));
  const proc = spawnServer(tmpDir, extraEnv);
  try {
    await rpcCall(proc, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
    }, rpcTimeoutMs);
    // Per MCP spec the client must follow up with `notifications/initialized`
    // before the server will accept any non-initialize request.
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const resp = await rpcCall(proc, 2, "tools/list", {}, rpcTimeoutMs);
    if (!resp.result?.tools) {
      throw new Error("tools/list returned no tools: " + JSON.stringify(resp));
    }
    return resp.result.tools.map((t: { name: string }) => t.name);
  } finally {
    proc.kill("SIGKILL");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function ensureDist(): boolean {
  if (fs.existsSync(SERVER_PATH)) return true;
  console.warn("[skip] dist/src/mcp-server.js not found — run npm run build first");
  return false;
}

describe("mcp-server: ZANA_DAEMON_TOOLS / ZANA_MASTER_MODE gating", () => {
  it(
    "default install EXPOSES daemon-only tools (daemon path is first-class), swarm still gated",
    async () => {
      if (!ensureDist()) return;
      const names = await listTools({});
      const present = new Set(names);

      // Daemon tools are surfaced by default now — ADR 0005.
      for (const n of DAEMON_GATED) {
        expect(present.has(n), `expected '${n}' to be VISIBLE by default (ZANA_DAEMON_TOOLS on)`).toBe(true);
      }
      // Swarm stays opt-in (ZANA_MASTER_MODE), even with the daemon surface on.
      for (const n of SWARM_GATED) {
        expect(present.has(n), `expected '${n}' to be HIDDEN when ZANA_MASTER_MODE is unset`).toBe(false);
      }

      // Sanity: a representative ungated tool is still visible.
      expect(present.has("zana_ticket_create")).toBe(true);
      expect(present.has("zana_memory_store")).toBe(true);

      // Full daemon surface (no swarm) — gives early warning if a future
      // commit accidentally drops one of these. Band, not exact, so unrelated
      // tool additions don't break it.
      expect(names.length).toBeGreaterThanOrEqual(84);
      expect(names.length).toBeLessThan(100);
    },
    20000,
  );

  it(
    "ZANA_DAEMON_TOOLS=0 opts out to the lean native-only surface",
    async () => {
      if (!ensureDist()) return;
      const names = await listTools({ ZANA_DAEMON_TOOLS: "0" });
      const present = new Set(names);

      for (const n of DAEMON_GATED) {
        expect(present.has(n), `expected '${n}' to be HIDDEN under ZANA_DAEMON_TOOLS=0`).toBe(false);
      }
      for (const n of SWARM_GATED) {
        expect(present.has(n), `expected '${n}' to be HIDDEN when ZANA_MASTER_MODE is unset`).toBe(false);
      }

      // Ungated tools remain.
      expect(present.has("zana_ticket_create")).toBe(true);
      expect(present.has("zana_memory_store")).toBe(true);

      // Leaner band when opted out.
      expect(names.length).toBeGreaterThanOrEqual(60);
      expect(names.length).toBeLessThan(80);
    },
    20000,
  );

  it(
    "ZANA_MASTER_MODE=true adds 6 swarm tools on top of the daemon surface",
    async () => {
      if (!ensureDist()) return;
      // This test spawns two server processes back-to-back; use a generous
      // per-RPC timeout (12 s) so that each initialize handshake has room to
      // complete even under load, and a total test timeout (50 s) that covers
      // two full spawn+initialize+tools/list round-trips.
      const namesDaemon = await listTools({ ZANA_DAEMON_TOOLS: "1" }, 12000);
      const namesAll = await listTools({
        ZANA_DAEMON_TOOLS: "1",
        ZANA_MASTER_MODE: "true",
      }, 12000);
      const present = new Set(namesAll);

      for (const n of SWARM_GATED) {
        expect(present.has(n), `expected '${n}' to be VISIBLE under ZANA_MASTER_MODE=true`).toBe(true);
      }
      expect(namesAll.length).toBe(namesDaemon.length + SWARM_GATED.length);
    },
    50000,
  );
});
