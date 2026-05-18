/**
 * cli-list-commands.test.ts — smoke tests for the read-only zana CLI list
 * commands (`ticket list`, `run list`, `schedule list`) and `stop --all`.
 *
 * These run the compiled `dist/bin/zana.js` via execFileSync. They do not
 * spawn a real daemon — `ticket list` is exercised only via its help text
 * and "no daemon" error path because the success path requires a live API.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ZANA_BIN = path.join(REPO_ROOT, "dist", "bin", "zana.js");

function runCli(args: string[], opts: { cwd?: string } = {}) {
  try {
    const out = execFileSync(process.execPath, [ZANA_BIN, ...args], {
      cwd: opts.cwd || REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { stdout: out, stderr: "", code: 0 };
  } catch (err: any) {
    return {
      stdout: String(err.stdout || ""),
      stderr: String(err.stderr || ""),
      code: err.status ?? 1,
    };
  }
}

describe("cli list commands: --help", () => {
  it("documents the new subcommands", () => {
    const result = runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/ticket list/);
    expect(result.stdout).toMatch(/run list/);
    expect(result.stdout).toMatch(/schedule list/);
    expect(result.stdout).toMatch(/stop --all/);
  });
});

describe("cli ticket list", () => {
  it("reports no daemon for a fresh workspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zana-cli-ticket-"));
    try {
      const result = runCli(["ticket", "list", "--workspace", tmp]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/no daemon running/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
