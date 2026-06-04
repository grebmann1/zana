'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync, execFileSync } = require('node:child_process');

const LABEL = 'com.zana.daemon';
const CONFIG_DIR = path.join(os.homedir(), '.zana');
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const DAEMON_BIN = path.resolve(__dirname, '..', 'bin', 'daemon.js');

function nodePath() {
  return process.execPath;
}

// XML entity escape for plist <string> bodies. Order matters — `&` first so
// later replacements don't double-escape. Without this, a workspace path
// containing `</string><string>...` could break out of WorkingDirectory and
// inject ProgramArguments into the launchd plist (persistent code execution).
function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Build the launchd plist text for the given inputs. Pure — exported under
// `__test` for unit tests; production callers go through `install()`.
function buildMacosPlist(opts: {
  label: string;
  node: string;
  daemonBin: string;
  workspace: string;
  port: string;
  logPath: string;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>`,
    `  <string>${escapeXml(opts.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(opts.node)}</string>`,
    `    <string>${escapeXml(opts.daemonBin)}</string>`,
    `    <string>--workspace</string>`,
    `    <string>${escapeXml(opts.workspace)}</string>`,
    `    <string>--port</string>`,
    `    <string>${escapeXml(opts.port)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(opts.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(opts.logPath)}</string>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(opts.workspace)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// --- macOS (launchd) ---

const macos = {
  plistPath() {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  },

  install(options = {}) {
    const workspace = path.resolve(options.workspace || process.cwd());
    const port = String(options.port || 47400);
    const label = options.label || LABEL;

    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(macos.plistPath()), { recursive: true });

    const logPath = path.join(LOG_DIR, 'daemon.log');

    const plist = buildMacosPlist({
      label,
      node: nodePath(),
      daemonBin: DAEMON_BIN,
      workspace,
      port,
      logPath,
    });

    fs.writeFileSync(macos.plistPath(), plist, 'utf8');
    // Use execFile-style argv (via execFileSync) so plistPath cannot be
    // injected into a shell command.
    execFileSync('launchctl', ['load', '-w', macos.plistPath()], { stdio: 'pipe' });
  },

  uninstall() {
    const plist = macos.plistPath();
    if (fs.existsSync(plist)) {
      try { execFileSync('launchctl', ['unload', plist], { stdio: 'pipe' }); } catch {}
      fs.unlinkSync(plist);
    }
  },

  status() {
    const plist = macos.plistPath();
    const installed = fs.existsSync(plist);
    let running = false;
    let pid = null;

    if (installed) {
      try {
        const out = execFileSync('launchctl', ['list', LABEL], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
        if (pidMatch) {
          pid = parseInt(pidMatch[1], 10);
          running = true;
        } else {
          const lines = out.split('\n');
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3 && parts[2] === LABEL && parts[0] !== '-') {
              pid = parseInt(parts[0], 10);
              running = !isNaN(pid) && pid > 0;
              break;
            }
          }
        }
      } catch {}
    }

    return { installed, running, pid };
  },

  logs(lines = 50) {
    const logPath = path.join(LOG_DIR, 'daemon.log');
    if (!fs.existsSync(logPath)) return '';
    try {
      const out = execSync(`tail -n ${lines} "${logPath}"`, { encoding: 'utf8' });
      return out;
    } catch { return ''; }
  },
};

// --- Linux (systemd) ---

const linux = {
  unitPath() {
    return path.join(os.homedir(), '.config', 'systemd', 'user', 'zana.service');
  },

  install(options = {}) {
    const workspace = path.resolve(options.workspace || process.cwd());
    const port = String(options.port || 47400);

    fs.mkdirSync(path.dirname(linux.unitPath()), { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const unit = [
      '[Unit]',
      'Description=Zana Daemon',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${nodePath()} ${DAEMON_BIN} --workspace=${workspace} --port=${port}`,
      `WorkingDirectory=${workspace}`,
      'Restart=on-failure',
      'RestartSec=5',
      `Environment=HOME=${os.homedir()}`,
      `StandardOutput=append:${path.join(LOG_DIR, 'daemon.log')}`,
      `StandardError=append:${path.join(LOG_DIR, 'daemon.log')}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');

    fs.writeFileSync(linux.unitPath(), unit, 'utf8');
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync('systemctl --user enable zana.service', { stdio: 'pipe' });
    execSync('systemctl --user start zana.service', { stdio: 'pipe' });
  },

  uninstall() {
    try { execSync('systemctl --user stop zana.service', { stdio: 'pipe' }); } catch {}
    try { execSync('systemctl --user disable zana.service', { stdio: 'pipe' }); } catch {}
    const unit = linux.unitPath();
    if (fs.existsSync(unit)) {
      fs.unlinkSync(unit);
    }
    try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch {}
  },

  status() {
    const installed = fs.existsSync(linux.unitPath());
    let running = false;
    let pid = null;

    if (installed) {
      try {
        const out = execSync('systemctl --user show zana.service --property=ActiveState,MainPID', { encoding: 'utf8' });
        const activeMatch = out.match(/ActiveState=(\w+)/);
        const pidMatch = out.match(/MainPID=(\d+)/);
        if (activeMatch && activeMatch[1] === 'active') running = true;
        if (pidMatch) {
          const p = parseInt(pidMatch[1], 10);
          if (p > 0) pid = p;
        }
      } catch {}
    }

    return { installed, running, pid };
  },

  logs(lines = 50) {
    const logPath = path.join(LOG_DIR, 'daemon.log');
    if (!fs.existsSync(logPath)) {
      try {
        return execSync(`journalctl --user -u zana.service -n ${lines} --no-pager`, { encoding: 'utf8' });
      } catch { return ''; }
    }
    try {
      return execSync(`tail -n ${lines} "${logPath}"`, { encoding: 'utf8' });
    } catch { return ''; }
  },
};

// --- Platform dispatch ---

function backend() {
  if (process.platform === 'darwin') return macos;
  if (process.platform === 'linux') return linux;
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function install(options) {
  return backend().install(options);
}

function uninstall() {
  return backend().uninstall();
}

function status() {
  return backend().status();
}

function logs(lines) {
  return backend().logs(lines);
}

module.exports = {
  install,
  uninstall,
  status,
  logs,
  // Test-only surface — pure helpers used by service-manager-xml-escape.test.ts.
  __test: { escapeXml, buildMacosPlist },
};
