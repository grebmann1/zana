// Integration test for packages/server/src/hooks/installer.ts.
//
// Strategy: redirect HOME to a tmpdir so the REAL @zana-ai/core's
// `config.BIN_DIR` / `config.CLAUDE_SETTINGS_BACKUP` resolve under the
// tmpdir. `isClaudeHost()` is steered by the public `ZANA_HOST_OVERRIDE`
// env var rather than a module mock — that's the documented external-control
// knob and keeps the boundary explicit. No internal-module mocks.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const { fakeHome, origHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require("node:os") as typeof import("node:os");
  const fakeHome = _fs.mkdtempSync(_path.join(_os.tmpdir(), "zana-installer-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return { fakeHome, origHome };
});

import {
  HOOK_EVENTS,
  isHooksInstalled,
  isMcpInstalled,
  installMcpServer,
} from "../../src/hooks/installer.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpHome: string;
let origHomeBeforeEach: string | undefined;
let origHostOverride: string | undefined;

function writeSettings(obj: unknown) {
  const dir = path.join(tmpHome, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj), "utf8");
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zana-installer-test-"));
  origHomeBeforeEach = process.env.HOME;
  process.env.HOME = tmpHome;
  origHostOverride = process.env.ZANA_HOST_OVERRIDE;
  // Default each test to "Claude host present" via the public env override.
  process.env.ZANA_HOST_OVERRIDE = "claude";
});

afterEach(() => {
  process.env.HOME = origHomeBeforeEach;
  if (origHostOverride === undefined) {
    delete process.env.ZANA_HOST_OVERRIDE;
  } else {
    process.env.ZANA_HOST_OVERRIDE = origHostOverride;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterAll(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
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
      if (orig === undefined) delete process.env.ZANA_SKIP_MCP_INSTALL;
      else process.env.ZANA_SKIP_MCP_INSTALL = orig;
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
    process.env.ZANA_HOST_OVERRIDE = "generic";
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
