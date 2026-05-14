// Hive Mind Spawner — manages sub-hive lifecycle (child processes).

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as http from "node:http";
import * as crypto from "node:crypto";

const subHives = new Map();
let changeListeners = [];

function notifyChange() {
  const snapshot = listSubHives();
  for (const cb of changeListeners) {
    try { cb(snapshot); } catch (err) {
      console.warn("[hivemind-spawner] listener callback error:", err.message || err);
    }
  }
}

export function spawnSubHive({ teamId, workspace, prompt, masterPort, masterHiveId }) {
  const hiveId = `sub-${crypto.randomUUID().slice(0, 8)}`;
  const headlessScript = path.join(__dirname, "..", "bin", "hive-headless.js");

  const args = [headlessScript, workspace];
  if (teamId) args.push(`--team=${teamId}`);

  const env = {
    ...process.env,
    HIVE_MASTER_PORT: String(masterPort),
    HIVE_MASTER_ID: masterHiveId || "",
    HIVE_ROLE: "sub",
  };
  if (prompt) env.HIVE_TEAM_PROMPT = prompt;

  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const record = {
    hiveId,
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

  subHives.set(hiveId, { record, child });
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
        // Spawn a single agent with the prompt in the sub-hive
        setTimeout(() => {
          postToSubHive(record.apiPort, "/agent/spawn", {
            profileId: "orchestrator",
            prompt,
            cwd: workspace,
          }).catch(() => {});
        }, 2000);
      }
    }

    // Forward to main process stderr for visibility
    process.stderr.write(`[${hiveId}] ${text}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${hiveId}:err] ${chunk.toString()}`);
  });

  child.on("exit", (code, signal) => {
    record.status = code === 0 ? "stopped" : "errored";
    notifyChange();
    // Clean up after a delay
    setTimeout(() => {
      subHives.delete(hiveId);
      notifyChange();
    }, 30000);
  });

  return { hiveId, pid: child.pid };
}

export function stopSubHive(hiveId) {
  const entry = subHives.get(hiveId);
  if (!entry) return { ok: false, error: "sub-hive not found" };

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

export async function instructSubHive(hiveId, message) {
  const entry = subHives.get(hiveId);
  if (!entry) return { ok: false, error: "sub-hive not found" };
  if (!entry.record.apiPort) return { ok: false, error: "sub-hive not ready (no port yet)" };

  const result = await postToSubHive(entry.record.apiPort, "/hivemind/instruct", { message });
  return result;
}

export async function getSubHiveAgents(hiveId) {
  const entry = subHives.get(hiveId);
  if (!entry) return [];
  if (!entry.record.apiPort) return [];

  try {
    return await getFromSubHive(entry.record.apiPort, "/agents");
  } catch {
    return [];
  }
}

export function listSubHives() {
  return Array.from(subHives.values()).map((e) => e.record);
}

export function getSubHive(hiveId) {
  const entry = subHives.get(hiveId);
  return entry ? entry.record : null;
}

export function getSubHivePorts() {
  return Array.from(subHives.values())
    .filter((e) => e.record.port && e.record.status === "running")
    .map((e) => e.record.port);
}

export function getSubHiveApiPorts() {
  return Array.from(subHives.values())
    .filter((e) => e.record.apiPort && e.record.status === "running")
    .map((e) => e.record.apiPort);
}

export function updateHeartbeat(hiveId) {
  const entry = subHives.get(hiveId);
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

function postToSubHive(port, urlPath, body) {
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

function getFromSubHive(port, urlPath) {
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

