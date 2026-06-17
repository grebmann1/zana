import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findClaude } from "@zana-ai/core/src/agents/spawner.ts";

// spawner.findClaude() resolves the worker binary with a fixed precedence:
//   1. ZANA_WORKER_BIN env override
//   2. ~/.local/bin/claude (if it exists)
//   3. first "claude" found by scanning $PATH dirs
//   4. the literal "claude" fallback
// The sibling spawner.test.ts pins arm 1 and only asserts arm 2-4 collapse to
// "some non-empty string". This file pins the two unguarded branches — the
// PATH scan (arm 3) and the literal fallback (arm 4) — deterministically by
// pointing HOME at a temp dir with no .local/bin/claude and controlling $PATH.
describe("findClaude — PATH scan and literal fallback", () => {
  const original = {
    bin: process.env.ZANA_WORKER_BIN,
    home: process.env.HOME,
    path: process.env.PATH,
  };
  let tmpHome: string;

  beforeEach(() => {
    delete process.env.ZANA_WORKER_BIN;
    // HOME with no .local/bin/claude so the ~/.local/bin branch is skipped.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zana-findclaude-home-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    const restore = (k: "ZANA_WORKER_BIN" | "HOME" | "PATH", v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("ZANA_WORKER_BIN", original.bin);
    restore("HOME", original.home);
    restore("PATH", original.path);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns the literal \"claude\" when no override, no ~/.local/bin/claude, and no PATH match", () => {
    // Empty-but-real dir on PATH: scanned, contains no "claude", so the loop
    // falls through to the literal fallback.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-findclaude-empty-"));
    process.env.PATH = emptyDir;
    try {
      expect(findClaude()).toBe("claude");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("returns the first PATH dir containing a \"claude\" entry", () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-findclaude-bin-"));
    const claudePath = path.join(binDir, "claude");
    fs.writeFileSync(claudePath, "#!/bin/sh\n");
    // A miss dir precedes the hit dir to prove the scan walks PATH in order.
    const missDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-findclaude-miss-"));
    process.env.PATH = `${missDir}${path.delimiter}${binDir}`;
    try {
      expect(findClaude()).toBe(claudePath);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(missDir, { recursive: true, force: true });
    }
  });
});
