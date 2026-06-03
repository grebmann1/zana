// Unit tests for packages/server/src/hooks/installer.ts
// Covers: HOOK_EVENTS shape, installMcpServer early-exits, isMcpInstalled
// file-presence logic, and isHooksInstalled guard paths.
// Uses a real tmpdir for HOME so no actual ~/.claude is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// ── Module mocks (must be hoisted before any imports of the module under test)

const mockIsClaudeHost = vi.hoisted(() => vi.fn(() => false));
vi.mock("@zana-ai/core/dist/src/host/detect.js", () => ({
  isClaudeHost: mockIsClaudeHost,
}));

vi.mock("@zana-ai/core", () => ({
  config: {
    BIN_DIR: "/tmp/fake-zana-bin",
    CLAUDE_SETTINGS_BACKUP: "/tmp/fake-zana-backup.json",
  },
}));

import {
  HOOK_EVENTS,
  isHooksInstalled,
  isMcpInstalled,
  installMcpServer,
} from "../../src/hooks/installer.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpHome: string;
let origHome: string | undefined;

function writeSettings(obj: unknown) {
  const dir = path.join(tmpHome, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj), "utf8");
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zana-installer-test-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  mockIsClaudeHost.mockReturnValue(true);
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── HOOK_EVENTS ───────────────────────────────────────────────────────────────

describe("HOOK_EVENTS", () => {
  it("exports exactly 7 hook events", () => {
    expect(HOOK_EVENTS).toHaveLength(7);
  });

  it("includes all required Claude Code lifecycle events", () => {
    for (const evt of ["SessionStart", "UserPromptSubmit", "PreToolUse",
                        "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]) {
      expect(HOOK_EVENTS).toContain(evt);
    }
  });
});

// ── installMcpServer ──────────────────────────────────────────────────────────

describe("installMcpServer", () => {
  it("returns {ok:true, skipped:true} when ZANA_SKIP_MCP_INSTALL=1", () => {
    const orig = process.env.ZANA_SKIP_MCP_INSTALL;
    process.env.ZANA_SKIP_MCP_INSTALL = "1";
    try {
      expect(installMcpServer(3000)).toEqual({ ok: true, skipped: true });
    } finally {
      process.env.ZANA_SKIP_MCP_INSTALL = orig;
    }
  });

  it("returns {ok:false} for a non-finite port (NaN)", () => {
    delete process.env.ZANA_SKIP_MCP_INSTALL;
    expect(installMcpServer(NaN)).toEqual({ ok: false, error: "invalid port" });
  });
});

// ── isMcpInstalled ────────────────────────────────────────────────────────────

describe("isMcpInstalled", () => {
  it("returns false when settings.json does not exist", () => {
    expect(isMcpInstalled()).toBe(false);
  });

  it("returns false when settings.json has no mcpServers.zana key", () => {
    writeSettings({ mcpServers: { other: {} } });
    expect(isMcpInstalled()).toBe(false);
  });

  it("returns true when settings.json contains mcpServers.zana", () => {
    writeSettings({ mcpServers: { zana: { command: "node", args: [] } } });
    expect(isMcpInstalled()).toBe(true);
  });
});

// ── isHooksInstalled ──────────────────────────────────────────────────────────

describe("isHooksInstalled", () => {
  it("returns false immediately when isClaudeHost() is false", () => {
    mockIsClaudeHost.mockReturnValue(false);
    expect(isHooksInstalled()).toBe(false);
  });

  it("returns false when settings.json does not exist", () => {
    expect(isHooksInstalled()).toBe(false);
  });

  it("returns false when settings.json exists but has no hooks property", () => {
    writeSettings({ mcpServers: {} });
    expect(isHooksInstalled()).toBe(false);
  });

  it("returns false when hooks object contains no entry with our command signature", () => {
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "some-other-tool" }] }],
      },
    });
    expect(isHooksInstalled()).toBe(false);
  });
});
