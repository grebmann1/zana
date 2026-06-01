// Hook installer behavior — fresh install, idempotency, and the wrapper-drift
// detection that catches stale post-hook.sh files from earlier Zana versions.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let installer: any;
let tmpHome: string;
let originalHome: string | undefined;
let originalHostOverride: string | undefined;

beforeEach(async () => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "zana-installer-"));
  originalHome = process.env.HOME;
  originalHostOverride = process.env.ZANA_HOST_OVERRIDE;
  process.env.HOME = tmpHome;
  // The installer's Phase 1 host guard short-circuits on non-Claude hosts.
  // These tests exercise the Claude path; force-on for that branch.
  process.env.ZANA_HOST_OVERRIDE = "claude";
  // Re-import so the installer's homeDir() picks up the new HOME.
  delete require.cache[require.resolve("@zana-ai/server/src/hooks/installer.ts")];
  installer = await import("@zana-ai/server/src/hooks/installer.ts");
  // The CLAUDE_SETTINGS_BACKUP path in @zana-ai/core/config is frozen at module
  // load time using the original os.homedir(), not process.env.HOME. Stub
  // backupIfNeeded() during the test so cross-machine backup writes don't
  // explode. The non-test code path is exercised in the "fresh install"
  // assertion above, where the path resolves correctly the first time.
  installer.__test_disableBackup?.();
  // Fallback for when the installer doesn't expose a hook: stub by intercepting
  // _config() via the @zana-ai/core facade. Simpler — just create the dst
  // directory and a benign backup file so copyFileSync's destination exists.
  const cfg = require("@zana-ai/core").config;
  fs.mkdirSync(path.dirname(cfg.CLAUDE_SETTINGS_BACKUP), { recursive: true });
  if (!fs.existsSync(cfg.CLAUDE_SETTINGS_BACKUP)) {
    fs.writeFileSync(cfg.CLAUDE_SETTINGS_BACKUP, "{}");
  }
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalHostOverride === undefined) delete process.env.ZANA_HOST_OVERRIDE;
  else process.env.ZANA_HOST_OVERRIDE = originalHostOverride;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("hook installer", () => {
  it("isHooksInstalled returns false on a fresh machine", () => {
    expect(installer.isHooksInstalled()).toBe(false);
  });

  it("installHooks deploys wrapper.sh and writes 7 events to settings.json", () => {
    const result = installer.installHooks(47402);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(installer.wrapperPath())).toBe(true);
    expect(fs.statSync(installer.wrapperPath()).mode & 0o777).toBe(0o755);
    const settings = JSON.parse(fs.readFileSync(installer.settingsPath(), "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  it("isHooksInstalled returns true after a clean install", () => {
    installer.installHooks(47402);
    expect(installer.isHooksInstalled()).toBe(true);
  });

  it("isHooksInstalled returns FALSE when wrapper drifts from bundled version", () => {
    // Pre-hardening case: hook entry in settings exists but the on-disk
    // wrapper.sh is the stale version (e.g. legacy ~/.zana/hives path,
    // sed-based terminal_id injection). core.ts gates re-install on this
    // return value, so we MUST fail it here so installHooks() runs again.
    installer.installHooks(47402);
    expect(installer.isHooksInstalled()).toBe(true);
    fs.writeFileSync(
      installer.wrapperPath(),
      "#!/bin/bash\necho stale > /dev/null\nexit 0\n",
      { mode: 0o755 }
    );
    expect(installer.isHooksInstalled()).toBe(false);
  });

  it("installHooks is idempotent — no duplicate entries on re-run", () => {
    installer.installHooks(47402);
    installer.installHooks(47402);
    const settings = JSON.parse(fs.readFileSync(installer.settingsPath(), "utf8"));
    for (const event of Object.values<any>(settings.hooks)) {
      const ours = event.filter((e: any) =>
        e.hooks?.some((h: any) => h.command?.includes("post-hook.sh"))
      );
      expect(ours.length).toBe(1);
    }
  });

  it("installHooks re-running with drifted wrapper restores it", () => {
    installer.installHooks(47402);
    fs.writeFileSync(installer.wrapperPath(), "stale", { mode: 0o755 });
    installer.installHooks(47402);
    const onDisk = fs.readFileSync(installer.wrapperPath(), "utf8");
    expect(onDisk).not.toBe("stale");
    expect(onDisk).toContain("MAX_DAEMONS"); // hardened wrapper marker
    expect(onDisk).toContain("jq"); // jq-safe injection marker
  });

  it("uninstallHooks removes our entries but preserves user hooks", () => {
    // Pre-existing user hook entry that should survive uninstall.
    fs.mkdirSync(path.dirname(installer.settingsPath()), { recursive: true });
    fs.writeFileSync(
      installer.settingsPath(),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Write",
              hooks: [{ type: "command", command: "echo user-hook" }],
            },
          ],
        },
      })
    );
    installer.installHooks(47402);
    installer.uninstallHooks();
    const settings = JSON.parse(fs.readFileSync(installer.settingsPath(), "utf8"));
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("echo user-hook");
  });

  it("installHooks skips silently on a non-Claude host", () => {
    process.env.ZANA_HOST_OVERRIDE = "generic";
    const result = installer.installHooks(47402);
    expect(result.ok).toBe(true);
    expect(result.skipped).toMatch(/not a Claude Code host/);
    expect(fs.existsSync(installer.settingsPath())).toBe(false);
  });

  it("uninstallHooks skips silently on a non-Claude host", () => {
    process.env.ZANA_HOST_OVERRIDE = "generic";
    const result = installer.uninstallHooks();
    expect(result.ok).toBe(true);
    expect(result.skipped).toMatch(/not a Claude Code host/);
  });

  it("isMcpInstalled and installMcpServer round-trip", () => {
    expect(installer.isMcpInstalled()).toBe(false);
    installer.installMcpServer(47402);
    expect(installer.isMcpInstalled()).toBe(true);
    const settings = JSON.parse(fs.readFileSync(installer.settingsPath(), "utf8"));
    expect(settings.mcpServers.zana.command).toBe("node");
    expect(settings.mcpServers.zana.env.ZANA_PORT).toBe("47402");
  });
});
