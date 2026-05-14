// Swarm Spawner — manages sub-daemon lifecycle (child processes).

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as http from "node:http";
import * as crypto from "node:crypto";

const subDaemons = new Map();
let changeListeners = [];

function notifyChange() {
  const snapshot = listSubDaemons();
  for (const cb of changeListeners) {
    try { cb(snapshot); } catch (err) {
      console.warn("[swarm-spawner] listener callback error:", err.message || err);
    }
  }
}

export function spawnSubDaemon({ teamId, workspace, prompt, masterPort, masterDaemonId }) {
  const daemonId = `sub-${crypto.randomUUID().slice(0, 8)}`;
  const headlessScript = path.join(__dirname, "..", "..", "bin", "daemon.js");
  const masterId = masterDaemonId;

  const args = [headlessScript, workspace];
  if (teamId) args.push(`--team=${teamId}`);

  const env = {
    ...process.env,
    ZANA_MASTER_PORT: String(masterPort),
    ZANA_MASTER_ID: masterId || "",
    ZANA_ROLE: "sub",
  };
  if (prompt) env.ZANA_TEAM_PROMPT = prompt;

  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const record = {
    daemonId,
    pid: child.pid,
    port: null,
    apiPort: null,
    workspace,
    teamId: teamId || null,
    teamName: null,
    status: "starting",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    prompt: prompt || null,
  };

  subDaemons.set(daemonId, { record, child });
  notifyChange();

  // Parse stdout for port announcement and forward output
  let stdoutBuf = "";
  let portFound = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    if (!portFound) stdoutBuf += text;

    // Look for API server port announcement
    const portMatch = !portFound && stdoutBuf.match(/API server on http:\/\/127\.0\.0\.1:(\d+)/);
    if (portMatch && !record.apiPort) {
      portFound = true;
      stdoutBuf = "";
      record.apiPort = parseInt(portMatch[1], 10);
      record.port = record.apiPort - 100;
      record.status = "running";
      notifyChange();

      // Send initial prompt if provided
      if (prompt && teamId) {
        // Team auto-start handles its own prompt, no extra action needed
      } else if (prompt && !teamId) {
        // Spawn a single agent with the prompt in the sub-daemon
        setTimeout(() => {
          postToSubDaemon(record.apiPort, "/agent/spawn", {
            profileId: "orchestrator",
            prompt,
            cwd: workspace,
          }).catch(() => {});
        }, 2000);
      }
    }

    // Forward to main process stderr for visibility
    process.stderr.write(`[${daemonId}] ${text}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${daemonId}:err] ${chunk.toString()}`);
  });

  child.on("exit", (code, signal) => {
    record.status = code === 0 ? "stopped" : "errored";
    notifyChange();
    // Clean up after a delay
    setTimeout(() => {
      subDaemons.delete(daemonId);
      notifyChange();
    }, 30000);
  });

  return { daemonId, pid: child.pid };
}

export function stopSubDaemon(daemonId) {
  const entry = subDaemons.get(daemonId);
  if (!entry) return { ok: false, error: "sub-daemon not found" };

  const { child, record } = entry;
  try {
    child.kill("SIGTERM");
    record.status = "stopped";
    notifyChange();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function instructSubDaemon(daemonId, message) {
  const entry = subDaemons.get(daemonId);
  if (!entry) return { ok: false, error: "sub-daemon not found" };
  if (!entry.record.apiPort) return { ok: false, error: "sub-daemon not ready (no port yet)" };

  const result = await postToSubDaemon(entry.record.apiPort, "/swarm/instruct", { message });
  return result;
}

export async function getSubDaemonAgents(daemonId) {
  const entry = subDaemons.get(daemonId);
  if (!entry) return [];
  if (!entry.record.apiPort) return [];

  try {
    return await getFromSubDaemon(entry.record.apiPort, "/agents");
  } catch {
    return [];
  }
}

export function listSubDaemons() {
  return Array.from(subDaemons.values()).map((e) => e.record);
}

export function getSubDaemon(daemonId) {
  const entry = subDaemons.get(daemonId);
  return entry ? entry.record : null;
}

export function getSubDaemonPorts() {
  return Array.from(subDaemons.values())
    .filter((e) => e.record.port && e.record.status === "running")
    .map((e) => e.record.port);
}

export function getSubDaemonApiPorts() {
  return Array.from(subDaemons.values())
    .filter((e) => e.record.apiPort && e.record.status === "running")
    .map((e) => e.record.apiPort);
}

export function updateHeartbeat(daemonId) {
  const entry = subDaemons.get(daemonId);
  if (entry) {
    entry.record.lastHeartbeat = Date.now();
  }
}

export function onChange(cb) {
  changeListeners.push(cb);
  return () => {
    changeListeners = changeListeners.filter((l) => l !== cb);
  };
}

// HTTP helpers

function postToSubDaemon(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 10000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve({ ok: res.statusCode < 400 }); }
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

function getFromSubDaemon(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: "GET",
      timeout: 5000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error("invalid JSON")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

