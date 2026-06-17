// Unit tests for appendAudit() in packages/core/src/events/log.ts
//
// appendAudit is the audit-trail writer used for session_start and other
// security/diagnostic events. It had no dedicated coverage despite being the
// single place audit records are persisted. Behaviors pinned here:
//   - creates the audit dir (recursive mkdir) if absent
//   - appends one NDJSON line per call (never truncates a prior record)
//   - each line is valid JSON carrying a numeric `ts` plus the caller payload
//
// Strategy: wire the workspace context (both the .ts-source and compiled-dist
// singletons, matching log-query.test.ts) at a fresh tmp dir so getAuditDir()
// resolves there instead of the real ~/.zana. No network, no real session.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as log from "@zana-ai/core/src/events/log.ts";

const wcDist: any = (core as any).project.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

let tmpDir: string;
let auditFile: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-log-audit-test-"));
  // Pre-create .zana/ so resolveProjectDir anchors here, not /tmp/.zana.
  fs.mkdirSync(path.join(tmpDir, ".zana"), { recursive: true });
  workspaceContextTs.init(tmpDir);
  wcDist.init(tmpDir);
  auditFile = path.join(wcDist.getProjectPaths().auditDir, "audit.ndjson");
});

afterAll(() => {
  resetWorkspace();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(): any[] {
  return fs
    .readFileSync(auditFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("appendAudit", () => {
  it("creates the audit dir and writes a JSON record with a numeric ts plus the payload", () => {
    expect(fs.existsSync(auditFile)).toBe(false); // dir not yet created

    log.appendAudit({ event: "session_start", sessionId: "sess-1", workspace: "ws" });

    expect(fs.existsSync(auditFile)).toBe(true);
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "session_start", sessionId: "sess-1", workspace: "ws" });
    expect(typeof lines[0].ts).toBe("number");
    expect(lines[0].ts).toBeGreaterThan(0);
  });

  it("appends successive records instead of overwriting the file", () => {
    log.appendAudit({ event: "agent_killed", agentId: "a-2" });

    const lines = readLines();
    expect(lines).toHaveLength(2); // first record from the previous test is preserved
    expect(lines[0].event).toBe("session_start");
    expect(lines[1]).toMatchObject({ event: "agent_killed", agentId: "a-2" });
  });
});
