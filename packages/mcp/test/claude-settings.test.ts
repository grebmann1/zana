// claude-settings unit tests — file I/O via a tmp path so no real ~/.claude is touched.
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const {
  readClaudeSettings,
  writeClaudeSettings,
  ensureMcpServer,
  ensureStatusLine,
} = require("../src/claude-settings.ts");

function tmpSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-settings-test-"));
  return path.join(dir, "settings.json");
}

// ── readClaudeSettings ─────────────────────────────────────────────────────────

describe("readClaudeSettings", () => {
  it("returns {} when the file does not exist", () => {
    const p = path.join(os.tmpdir(), "no-such-file-zana-test.json");
    expect(readClaudeSettings(p)).toEqual({});
  });

  it("returns {} for an empty file", () => {
    const p = tmpSettings();
    fs.writeFileSync(p, "   ");
    expect(readClaudeSettings(p)).toEqual({});
  });

  it("parses valid JSON from the file", () => {
    const p = tmpSettings();
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { zana: { cmd: "node" } } }));
    expect(readClaudeSettings(p)).toEqual({ mcpServers: { zana: { cmd: "node" } } });
  });
});

// ── writeClaudeSettings ────────────────────────────────────────────────────────

describe("writeClaudeSettings", () => {
  it("creates the directory if needed and writes pretty-printed JSON with trailing newline", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-write-test-"));
    const p = path.join(dir, "nested", "settings.json");
    writeClaudeSettings({ foo: "bar" }, p);
    const raw = fs.readFileSync(p, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ foo: "bar" });
  });
});

// ── ensureMcpServer ────────────────────────────────────────────────────────────

describe("ensureMcpServer", () => {
  it("throws when serverConfig is missing", () => {
    expect(() => ensureMcpServer({ serverConfig: null, settingsPath: tmpSettings() })).toThrow(
      /valid serverConfig/
    );
  });

  it("adds a new server entry and returns status=added", () => {
    const p = tmpSettings();
    const cfg = { command: "node", args: ["server.js"] };
    const result = ensureMcpServer({ serverConfig: cfg, settingsPath: p });
    expect(result.status).toBe("added");
    expect(JSON.parse(fs.readFileSync(p, "utf8")).mcpServers.zana).toEqual(cfg);
  });

  it("returns status=unchanged when config matches existing entry", () => {
    const p = tmpSettings();
    const cfg = { command: "node" };
    ensureMcpServer({ serverConfig: cfg, settingsPath: p });
    const result = ensureMcpServer({ serverConfig: cfg, settingsPath: p });
    expect(result.status).toBe("unchanged");
  });

  it("returns status=different when config differs and repairIfDifferent is false", () => {
    const p = tmpSettings();
    ensureMcpServer({ serverConfig: { command: "node" }, settingsPath: p });
    const result = ensureMcpServer({
      serverConfig: { command: "bun" },
      settingsPath: p,
    });
    expect(result.status).toBe("different");
    // original config must not be overwritten
    expect(JSON.parse(fs.readFileSync(p, "utf8")).mcpServers.zana.command).toBe("node");
  });

  it("updates config and returns status=updated when repairIfDifferent=true", () => {
    const p = tmpSettings();
    ensureMcpServer({ serverConfig: { command: "node" }, settingsPath: p });
    const result = ensureMcpServer({
      serverConfig: { command: "bun" },
      settingsPath: p,
      repairIfDifferent: true,
    });
    expect(result.status).toBe("updated");
    expect(JSON.parse(fs.readFileSync(p, "utf8")).mcpServers.zana.command).toBe("bun");
  });

  it("overwrites an existing entry and returns status=updated when overwrite=true, even if config matches", () => {
    const p = tmpSettings();
    const cfg = { command: "node" };
    ensureMcpServer({ serverConfig: cfg, settingsPath: p });
    // Identical config would normally yield "unchanged"; overwrite forces a write.
    const result = ensureMcpServer({ serverConfig: cfg, settingsPath: p, overwrite: true });
    expect(result.status).toBe("updated");
    expect(JSON.parse(fs.readFileSync(p, "utf8")).mcpServers.zana).toEqual(cfg);
  });

  it("removes legacy keys listed in migrateFrom", () => {
    const p = tmpSettings();
    // Seed with old "hive" key
    writeClaudeSettings({ mcpServers: { hive: { command: "old" } } }, p);
    ensureMcpServer({ serverConfig: { command: "node" }, settingsPath: p });
    const saved = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(saved.mcpServers.hive).toBeUndefined();
    expect(saved.mcpServers.zana).toBeDefined();
  });
});

// ── ensureStatusLine ──────────────────────────────────────────────────────────

describe("ensureStatusLine", () => {
  it("throws when scriptPath is missing", () => {
    expect(() => ensureStatusLine({ scriptPath: "", settingsPath: tmpSettings() })).toThrow(
      /scriptPath/
    );
  });

  it("adds statusLine and returns status=added on a fresh file", () => {
    const p = tmpSettings();
    const result = ensureStatusLine({ scriptPath: "/usr/local/bin/statusline.js", settingsPath: p });
    expect(result.status).toBe("added");
    const saved = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(saved.statusLine.type).toBe("command");
    expect(saved.statusLine.command).toContain("statusline.js");
  });

  it("returns status=unchanged when identical config already exists", () => {
    const p = tmpSettings();
    ensureStatusLine({ scriptPath: "/bin/sl.js", settingsPath: p });
    const result = ensureStatusLine({ scriptPath: "/bin/sl.js", settingsPath: p });
    expect(result.status).toBe("unchanged");
  });

  it("returns status=different for a non-legacy different config without repair", () => {
    const p = tmpSettings();
    writeClaudeSettings({ statusLine: { type: "command", command: "echo hi", padding: 1, refreshInterval: 30 } }, p);
    const result = ensureStatusLine({ scriptPath: "/bin/sl.js", settingsPath: p });
    expect(result.status).toBe("different");
  });

  it("replaces a legacy statusLine command when matched against legacyMarkers", () => {
    const p = tmpSettings();
    writeClaudeSettings(
      { statusLine: { type: "command", command: 'node "statusline-zana.sh"', padding: 1, refreshInterval: 30 } },
      p
    );
    const result = ensureStatusLine({ scriptPath: "/new/statusline.js", settingsPath: p });
    expect(result.status).toBe("updated");
    const saved = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(saved.statusLine.command).toContain("statusline.js");
  });

  it("escapes double-quotes in scriptPath", () => {
    const p = tmpSettings();
    const weirdPath = '/path/with "quotes"/sl.js';
    ensureStatusLine({ scriptPath: weirdPath, settingsPath: p });
    const saved = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(saved.statusLine.command).toContain('\\"quotes\\"');
  });
});
