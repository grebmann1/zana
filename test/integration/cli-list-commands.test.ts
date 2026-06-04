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

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  try {
    const out = execFileSync(process.execPath, [ZANA_BIN, ...args], {
      cwd: opts.cwd || REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: { ...process.env, ...(opts.env || {}) },
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

describe("cli stop --all", () => {
  it("clears the registry and reports the count", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zana-cli-stop-"));
    try {
      // Two fake entries: one with a definitely-dead pid (we never SIGTERM
      // it because isProcessAlive returns false), the other with our own
      // PID — but we use a JSON shape that, after SIGTERM, would just be
      // a no-op signal back to ourselves. To stay safe, both entries use
      // dead pids; the kill loop will skip them and still clean the dir.
      fs.writeFileSync(
        path.join(tmp, "alpha.json"),
        JSON.stringify({ id: "alpha", port: 47400, pid: 99999, workspace: "/x", headless: true })
      );
      fs.writeFileSync(
        path.join(tmp, "beta.json"),
        JSON.stringify({ id: "beta", port: 47402, pid: 99998, workspace: "/y", headless: true })
      );

      const result = runCli(["stop", "--all"], { env: { ZANA_DAEMONS_DIR: tmp } });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/stopped 2 daemon\(s\)/);
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports zero when registry dir does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zana-cli-stop-"));
    try {
      const missing = path.join(tmp, "does-not-exist");
      const result = runCli(["stop", "--all"], { env: { ZANA_DAEMONS_DIR: missing } });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/stopped 0 daemon\(s\)/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

describe("cli schedule list", () => {
  it("emits '(no scheduler directory)' for a fresh workspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zana-cli-sched-"));
    try {
      // Pre-create .zana/ so resolveProjectDir stops here and doesn't walk
      // up to any ambient /tmp/.zana that may exist on the host machine.
      fs.mkdirSync(path.join(tmp, ".zana"), { recursive: true });
      const result = runCli(["schedule", "list", "--workspace", tmp]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/no scheduler directory/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("renders YAML schedules with status fields", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zana-cli-sched-"));
    try {
      const schedDir = path.join(tmp, ".zana", "scheduler");
      fs.mkdirSync(schedDir, { recursive: true });
      const future = new Date(Date.now() + 5 * 60_000).toISOString();
      const yaml = [
        "id: my-task",
        "name: Daily audit",
        "enabled: true",
        "schedule:",
        "  every: 10m",
        "  intervalMs: 600000",
        "status:",
        `  nextRunAt: ${future}`,
        "  lastRunResult: success",
        "  runCount: 7",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(schedDir, "my-task.yml"), yaml);

      const result = runCli(["schedule", "list", "--workspace", tmp]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^my-task \| enabled \| every 10m \| next in \d+m \| runCount 7 \| Daily audit last=success/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("cli run list", () => {
  it("emits '(no runs directory)' for a fresh workspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zana-cli-run-"));
    try {
      // Pre-create .zana/ so resolveProjectDir stops here and doesn't walk
      // up to any ambient /tmp/.zana that may exist on the host machine.
      fs.mkdirSync(path.join(tmp, ".zana"), { recursive: true });
      const result = runCli(["run", "list", "--workspace", tmp]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/no runs directory/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("formats run entries from .zana/runs/*.json sorted by terminatedAt desc", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zana-cli-run-"));
    try {
      const runsDir = path.join(tmp, ".zana", "runs");
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(
        path.join(runsDir, "older.json"),
        JSON.stringify({
          id: "older-run-id",
          profileId: "tester",
          state: "terminated",
          tokensIn: 5,
          tokensOut: 9,
          costUsd: 0.0123,
          durationMs: 1234,
          terminatedAt: "2026-01-01T00:00:00.000Z",
        })
      );
      fs.writeFileSync(
        path.join(runsDir, "newer.json"),
        JSON.stringify({
          id: "newer-run-id",
          profileId: "coder",
          state: "terminated",
          tokensIn: 10,
          tokensOut: 20,
          costUsd: 0.05,
          durationMs: 999,
          terminatedAt: "2026-05-01T00:00:00.000Z",
        })
      );

      const result = runCli(["run", "list", "--limit", "5", "--workspace", tmp]);
      expect(result.code).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^newer-ru \| coder \| terminated \| tok=10\/20 \| \$0\.0500 \| 999ms \| 2026-05-01/);
      expect(lines[1]).toMatch(/^older-ru \| tester \| terminated \| tok=5\/9 \| \$0\.0123 \| 1234ms \| 2026-01-01/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
