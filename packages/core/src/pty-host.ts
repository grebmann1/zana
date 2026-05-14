import * as os from "os";

let pty;
try {
  pty = require("node-pty");
} catch {
  pty = null;
}

const live = new Map();

const dataListeners = [];
const exitListeners = [];

function defaultShell() {
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function defaultCwd() {
  return process.env.HOME || os.homedir() || process.cwd();
}

export function spawnTerminal({ terminalId, cwd, shell, cols, rows, env }) {
  if (!pty) {
    throw new Error("node-pty is not installed. Interactive terminals require: npm install node-pty");
  }
  if (live.has(terminalId)) return live.get(terminalId);

  const resolvedShell = shell || defaultShell();
  const resolvedCwd = cwd || defaultCwd();

  const resolvedEnv = {
    ...process.env,
    ...(env || {}),
    HIVE_TERMINAL_ID: terminalId,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };

  const ptyProc = pty.spawn(resolvedShell, [], {
    name: "xterm-256color",
    cols: Number.isFinite(cols) ? cols : 80,
    rows: Number.isFinite(rows) ? rows : 24,
    cwd: resolvedCwd,
    env: resolvedEnv,
  });

  const entry = {
    terminalId,
    pty: ptyProc,
    cwd: resolvedCwd,
    shell: resolvedShell,
    pid: ptyProc.pid,
  };
  live.set(terminalId, entry);

  ptyProc.onData((data) => {
    for (const cb of dataListeners) {
      try {
        cb({ terminalId, data });
      } catch {}
    }
  });
  ptyProc.onExit(({ exitCode, signal }) => {
    for (const cb of exitListeners) {
      try {
        cb({ terminalId, exitCode, signal });
      } catch {}
    }
    live.delete(terminalId);
  });

  return entry;
}

export function writeTerminal(terminalId, data) {
  const e = live.get(terminalId);
  if (!e) return false;
  try {
    e.pty.write(data);
    return true;
  } catch {
    return false;
  }
}

export function resizeTerminal(terminalId, cols, rows) {
  const e = live.get(terminalId);
  if (!e) return false;
  try {
    e.pty.resize(
      Number.isFinite(cols) ? cols : 80,
      Number.isFinite(rows) ? rows : 24,
    );
    return true;
  } catch {
    return false;
  }
}

export function killTerminal(terminalId) {
  const e = live.get(terminalId);
  if (!e) return false;
  try {
    e.pty.kill();
  } catch {}
  live.delete(terminalId);
  return true;
}

export function getTerminal(terminalId) {
  return live.get(terminalId) || null;
}

export function listTerminals() {
  return Array.from(live.values()).map((e) => ({
    terminalId: e.terminalId,
    pid: e.pid,
    cwd: e.cwd,
    shell: e.shell,
  }));
}

export function onTerminalData(cb) {
  dataListeners.push(cb);
  return () => {
    const i = dataListeners.indexOf(cb);
    if (i >= 0) dataListeners.splice(i, 1);
  };
}

export function onTerminalExit(cb) {
  exitListeners.push(cb);
  return () => {
    const i = exitListeners.indexOf(cb);
    if (i >= 0) exitListeners.splice(i, 1);
  };
}

export function killAll() {
  for (const id of Array.from(live.keys())) {
    killTerminal(id);
  }
}

