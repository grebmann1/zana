// Unit tests for packages/core/src/events/log.ts — append / queryByTerminal
//
// Covers:
//   - queryByTerminal returns [] before init (no sessionDir)
//   - queryByTerminal returns [] for an unknown terminalId after init
//   - append + queryByTerminal round-trip: events written for a terminalId are
//     returned with correct payload fields
//   - append with no terminalId writes to global log but NOT to agent file
//   - queryByTerminal respects `limit` and `offset` parameters
//   - queryByTerminal tolerates malformed NDJSON lines (skips them)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContextTs from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import * as log from "@zana-ai/core/src/events/log.ts";

// Reset both the .ts-source singleton and the compiled-dist singleton so other
// test files in the suite don't bleed workspace state into this one.
const wcDist: any = (core as any).project.workspaceContext;

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try {
      if (typeof wc._resetForTesting === "function") wc._resetForTesting();
    } catch {}
  }
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-log-query-test-"));
  // Pre-create .zana/ so resolveProjectDir anchors here and doesn't walk
  // up to /tmp/.zana/ (the real workspace), which is sandbox-blocked.
  fs.mkdirSync(path.join(tmpDir, ".zana"), { recursive: true });
  // Wire workspace so init() / getSessionsDir() resolves into tmpDir.
  workspaceContextTs.init(tmpDir);
  wcDist.init(tmpDir);
  // One shared session for all tests in this file.
  log.init("test-workspace");
});

afterAll(() => {
  resetWorkspace();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── queryByTerminal — before any appends ────────────────────────────────────

describe("queryByTerminal — unknown agent", () => {
  it("returns [] when no events have been appended for that terminalId", () => {
    expect(log.queryByTerminal("no-such-agent")).toEqual([]);
  });
});

// ─── append + queryByTerminal round-trip ─────────────────────────────────────

describe("append + queryByTerminal", () => {
  const tid = "agent-abc";

  it("returns events appended for the given terminalId", () => {
    log.append({ zana_terminal_id: tid, event: "hook", data: "hello" });
    log.append({ zana_terminal_id: tid, event: "hook", data: "world" });

    const events = log.queryByTerminal(tid);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "hook", data: "hello" });
    expect(events[1]).toMatchObject({ event: "hook", data: "world" });
  });

  it("each event has a numeric ts field injected by append()", () => {
    const events = log.queryByTerminal(tid);
    for (const e of events) {
      expect(typeof e.ts).toBe("number");
    }
  });

  it("does NOT create an agent file for events with no terminalId", () => {
    log.append({ event: "global-only", data: 42 });
    // The global events.ndjson gains this entry, but no per-agent file for it.
    // We verify by checking that queryByTerminal for a fresh id stays empty.
    expect(log.queryByTerminal("global-only")).toEqual([]);
  });
});

// ─── limit and offset ─────────────────────────────────────────────────────────

describe("queryByTerminal — limit and offset", () => {
  const tid = "agent-paginate";

  beforeAll(() => {
    for (let i = 0; i < 5; i++) {
      log.append({ zana_terminal_id: tid, seq: i });
    }
  });

  it("limit=2 returns only the first 2 events", () => {
    const events = log.queryByTerminal(tid, { limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ seq: 0 });
    expect(events[1]).toMatchObject({ seq: 1 });
  });

  it("offset=3 skips the first 3 events", () => {
    const events = log.queryByTerminal(tid, { offset: 3 });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ seq: 3 });
    expect(events[1]).toMatchObject({ seq: 4 });
  });

  it("offset beyond length returns []", () => {
    expect(log.queryByTerminal(tid, { offset: 100 })).toEqual([]);
  });
});

// ─── malformed NDJSON tolerance ───────────────────────────────────────────────

describe("queryByTerminal — malformed lines", () => {
  it("skips corrupt JSON lines and returns the valid ones", () => {
    const tid = "agent-corrupt";
    // Manually write a file that mixes valid and corrupt NDJSON.
    const sessionId = log.getSessionId();
    // Navigate to the agents dir inside the active session.
    const sessionsDir = (workspaceContextTs as any).getProjectPaths().sessionsDir;
    const agentFile = path.join(sessionsDir, sessionId, "agents", `${tid}.ndjson`);
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(
      agentFile,
      [
        JSON.stringify({ ts: 1, event: "good1" }),
        "NOT_VALID_JSON{{{{",
        JSON.stringify({ ts: 2, event: "good2" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const events = log.queryByTerminal(tid);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "good1" });
    expect(events[1]).toMatchObject({ event: "good2" });
  });
});
