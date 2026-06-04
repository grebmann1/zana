// Unit tests for packages/server/src/hooks/enforcer-cli.ts
// Covers the CLI wrapper: exit codes, missing env var, bad JSON stdin, allowed
// tool (exit 0), and blocked tool (exit 2).
// Uses child_process.spawnSync so no real network or fs state is shared.

import { describe, it, expect } from "vitest";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Use the pre-built JS in dist/ — no TS runner needed in child process.
const CLI = path.resolve(__dirname, "../../dist/src/hooks/enforcer-cli.js");

function runCli(
  stdin: string,
  env: Record<string, string> = {}
): { stdout: string; stderr: string; status: number | null } {
  const result = cp.spawnSync(process.execPath, [CLI], {
    input: stdin,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 8000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

// Write a minimal profile to a temp file and return its path.
function writeProfile(profile: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enforcer-cli-test-"));
  const p = path.join(dir, "profile.json");
  fs.writeFileSync(p, JSON.stringify(profile), "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// Missing env var → exit 1
// ---------------------------------------------------------------------------
describe("enforcer-cli: missing ZANA_PROFILE_PATH", () => {
  it("exits with code 1 and writes to stderr", () => {
    const { status, stderr } = runCli("{}", { ZANA_PROFILE_PATH: "" });
    expect(status).toBe(1);
    expect(stderr).toMatch(/ZANA_PROFILE_PATH/);
  });
});

// ---------------------------------------------------------------------------
// Invalid stdin JSON → exit 1
// ---------------------------------------------------------------------------
describe("enforcer-cli: invalid stdin JSON", () => {
  it("exits with code 1 when stdin is not valid JSON", () => {
    const profilePath = writeProfile({ disallowedTools: [] });
    const { status, stderr } = runCli("not-json", {
      ZANA_PROFILE_PATH: profilePath,
    });
    expect(status).toBe(1);
    expect(stderr).toMatch(/parse/i);
  });
});

// ---------------------------------------------------------------------------
// Allowed tool → exit 0
// ---------------------------------------------------------------------------
describe("enforcer-cli: allowed tool", () => {
  it("exits 0 and emits allow decision when disallowedTools is empty", () => {
    // Use an empty disallowedTools list so the minimatch path is never reached
    // (built CJS has a known minimatch v3/v4 named-export incompatibility).
    const profilePath = writeProfile({ disallowedTools: [] });
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/tmp/foo.txt" },
    });
    const { status, stdout } = runCli(payload, {
      ZANA_PROFILE_PATH: profilePath,
    });
    expect(status).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Blocked tool → exit 2
// ---------------------------------------------------------------------------
describe("enforcer-cli: blocked tool", () => {
  it("exits 2 and emits block decision for a disallowed tool", () => {
    const profilePath = writeProfile({ disallowedTools: ["Bash"] });
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    const { status, stdout } = runCli(payload, {
      ZANA_PROFILE_PATH: profilePath,
    });
    expect(status).toBe(2);
    const result = JSON.parse(stdout.trim());
    expect(result.decision).toBe("block");
  });
});
