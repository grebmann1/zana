// Regression guard for ticket f696cb72 — "Session events.ndjson is always empty
// for headless agents".
//
// THE BUG: events.ndjson is written only by eventLog.append(), which prior to
// the fix was called from a single place — the hook-server callback in core.ts
// (`eventLog.append(payload)`). That HTTP path fires only for INTERACTIVE agents,
// whose Claude Code hooks POST back to the daemon. HEADLESS agents never POST
// hooks; their tool activity arrives exclusively over the stream-json STDOUT of
// the spawned `claude` child, parsed in launchHeadlessChild() (agents/lifecycle.ts).
// That stdout loop parsed assistant/result frames but never emitted a tool event,
// so a headless agent's tool calls never reached events.ndjson and stats-engine's
// agent:hook / PostToolUse tallies came out empty for every headless run.
//
// THE FIX: launchHeadlessChild() now, for each `tool_use` block in an assistant
// turn, emits BOTH sinks the interactive path feeds — bus.emit(AGENT_HOOK) (→
// work/tracker → stats-engine) and eventLog.append(payload) (→ events.ndjson +
// per-agent agents/<terminalId>.ndjson) — with the SAME payload shape the hook
// server produces:
//   { agentId, zana_terminal_id, hook_event_name: "PostToolUse", tool_name, tool_input }
//
// STRATEGY (tmpdir integration, no Claude, no internal-module mocking):
// We mock ONLY the process boundary — ./spawner's spawnHeadless — to return a
// fake child (an EventEmitter with a .stdout stream), mirroring the established
// pattern in lifecycle-killed-skips-anomaly.test.ts. Everything else is the REAL
// production code: the real launchHeadlessChild stdout handler, the real bus, and
// the real eventLog.append writing to a real tmpdir session. We then push a
// genuine stream-json assistant frame (with tool_use blocks) onto child.stdout and
// assert the events land on disk in events.ndjson AND the per-agent file in the
// exact shape stats-engine consumes — feeding them through the real stats-engine
// computeOverview/computeToolBreakdown to prove end-to-end usefulness.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── process-boundary mock: spawnHeadless returns a fake child we drive by hand ──
// This replaces ONLY the spawn() of a real `claude` process. The stdout-handler
// logic, the bus, and eventLog.append remain the real production modules.
let lastChild: any;
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 9931;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: false };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

vi.mock("@zana-ai/core/src/agents/spawner.ts", () => ({
  buildInteractiveCommand: vi.fn(() => ({ command: "echo", args: [] })),
  spawnHeadless: vi.fn(() => (lastChild = makeFakeChild())),
}));

// model-router is mocked to avoid pulling its real selection path into this
// test; it is unrelated to the event-emission behaviour under test.
vi.mock("@zana-ai/core/src/agents/model-router.ts", () => ({
  selectModel: vi.fn(() => "claude-haiku-routed"),
  TIERS: {},
}));

import { spawnHeadlessAgent } from "@zana-ai/core/src/agents/lifecycle.ts";
import { bus, EVENTS } from "@zana-ai/core/src/events/bus.ts";
import * as eventLogTs from "@zana-ai/core/src/events/log.ts";
import * as workspaceContextTs from "@zana-ai/core/src/project/workspace-context.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";
import {
  computeOverview,
  computeToolBreakdown,
} from "@zana-ai/core/src/events/stats-engine.ts";
import * as core from "@zana-ai/core";

// log.ts's _ctx() prefers the dist facade's workspace-context singleton, falling
// back to the source instance. To make the session resolve to our tmpdir no
// matter which one wins, init BOTH (the tenant-isolation suite uses the same
// dual-init trick).
const wcDist: any = (core as any).project.workspaceContext;
// eventLog under test (the one lifecycle.ts writes through) is the SOURCE module.
const eventLog: any = eventLogTs;

const PROFILE = { id: "tester", displayName: "Tester", icon: "🧪", category: "general" };

const created: string[] = [];
function makeTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

function resetWorkspace() {
  for (const wc of [workspaceContextTs as any, wcDist]) {
    try { if (typeof wc._resetForTesting === "function") wc._resetForTesting(); } catch {}
  }
}

// Resolve the on-disk session directory eventLog.init() created. log.ts uses
// the dist facade context first, so its sessionsDir is where the files live.
function sessionDir(): string {
  const sessionsDir = wcDist.getProjectPaths().sessionsDir;
  return path.join(sessionsDir, eventLog.getSessionId());
}

function readNdjson(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// A genuine stream-json assistant frame carrying two tool_use blocks plus a text
// block — exactly the shape the claude CLI emits on `--output-format stream-json`.
function assistantFrameWithTools() {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "I'll read the file then edit it." },
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/a.ts" } },
        { type: "tool_use", name: "Edit", input: { file_path: "/tmp/a.ts", old_string: "x", new_string: "y" } },
      ],
    },
  }) + "\n";
}

describe("headless agent tool events land in events.ndjson (ticket f696cb72)", () => {
  let root: string;

  beforeEach(() => {
    resetWorkspace();
    root = makeTmp("zana-headless-ndjson-");
    // module config lives in the tmpdir so getMaxConcurrentAgents/timeouts read
    // from an isolated file rather than the developer's real config.
    moduleConfig.setConfigPath(path.join(root, "config.json"));
    // Init BOTH workspace-context instances to the tmpdir, then start a fresh
    // event-log session. The real eventLog.init creates <sessionsDir>/<id>/.
    workspaceContextTs.init(root);
    wcDist.init(root);
    eventLog.init(root);
  });

  afterEach(() => {
    bus.removeAllListeners(EVENTS.AGENT_HOOK);
    bus.removeAllListeners(EVENTS.AGENT_SPAWNED);
    bus.removeAllListeners(EVENTS.AGENT_TERMINATED);
    for (const d of created.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    resetWorkspace();
  });

  it("writes one PostToolUse line per tool_use block into events.ndjson", () => {
    const { terminalId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    // Drive the REAL stdout-handler with a genuine assistant stream-json frame.
    lastChild.stdout.emit("data", Buffer.from(assistantFrameWithTools()));

    const globalPath = path.join(sessionDir(), "events.ndjson");
    const lines = readNdjson(globalPath).filter((e) => e.zana_terminal_id === terminalId);

    // Two tool_use blocks → two PostToolUse lines (the text block is NOT a tool).
    expect(lines).toHaveLength(2);
    for (const ln of lines) {
      expect(ln.hook_event_name).toBe("PostToolUse");
      expect(ln.zana_terminal_id).toBe(terminalId);
      expect(typeof ln.ts).toBe("number"); // append() stamps each line
    }
    expect(lines.map((l) => l.tool_name).sort()).toEqual(["Edit", "Read"]);
  });

  it("preserves tool_input (file_path survives for Write/Edit file tracking)", () => {
    const { terminalId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    lastChild.stdout.emit("data", Buffer.from(assistantFrameWithTools()));

    const lines = readNdjson(path.join(sessionDir(), "events.ndjson"))
      .filter((e) => e.zana_terminal_id === terminalId);
    const edit = lines.find((l) => l.tool_name === "Edit");
    expect(edit?.tool_input?.file_path).toBe("/tmp/a.ts");
    const read = lines.find((l) => l.tool_name === "Read");
    expect(read?.tool_input?.file_path).toBe("/tmp/a.ts");
  });

  it("also mirrors the events into the per-agent agents/<terminalId>.ndjson file", () => {
    const { terminalId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    lastChild.stdout.emit("data", Buffer.from(assistantFrameWithTools()));

    const agentFile = path.join(sessionDir(), "agents", `${terminalId}.ndjson`);
    const perAgent = readNdjson(agentFile);
    expect(perAgent).toHaveLength(2);
    expect(perAgent.map((l) => l.tool_name).sort()).toEqual(["Edit", "Read"]);
    // queryByTerminal reads those flat lines back verbatim.
    const queried = eventLog.queryByTerminal(terminalId);
    expect(queried).toHaveLength(2);
  });

  it("the persisted lines feed stats-engine as PostToolUse tool calls", () => {
    const { terminalId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    lastChild.stdout.emit("data", Buffer.from(assistantFrameWithTools()));

    // stats-engine consumes events shaped { type, payload, timestamp }. The
    // events.ndjson lines are the flat payload; wrap them the way work/tracker
    // does (type:"agent:hook", payload:line) to prove they are stats-usable.
    const flat = readNdjson(path.join(sessionDir(), "events.ndjson"))
      .filter((e) => e.zana_terminal_id === terminalId);
    const statsEvents = flat.map((line) => ({
      type: "agent:hook",
      payload: line,
      timestamp: line.ts,
    }));

    const overview = computeOverview(statsEvents);
    expect(overview.totalToolCalls).toBe(2);

    expect(computeToolBreakdown(statsEvents)).toEqual({ Read: 1, Edit: 1 });
  });

  it("emits a matching bus AGENT_HOOK per tool_use (the other sink stats-engine reads live)", () => {
    const hooks: any[] = [];
    bus.on(EVENTS.AGENT_HOOK, (p: any) => hooks.push(p));

    const { agentId, terminalId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    lastChild.stdout.emit("data", Buffer.from(assistantFrameWithTools()));

    const mine = hooks.filter((h) => h.zana_terminal_id === terminalId);
    expect(mine).toHaveLength(2);
    for (const h of mine) {
      expect(h.hook_event_name).toBe("PostToolUse");
      expect(h.agentId).toBe(agentId);
    }
    expect(mine.map((h) => h.tool_name).sort()).toEqual(["Edit", "Read"]);
  });

  // The stdout handler runs its tool-emission loop once PER assistant frame
  // (agents/lifecycle.ts: child.stdout 'data' -> text.split("\n") -> per-line).
  // A real headless session streams MULTIPLE assistant turns over the life of
  // the child — e.g. read in one turn, run a command in a later turn. Every
  // case above drives a SINGLE frame, so cumulative emission across turns is
  // unpinned: a regression that emitted only for the first frame (or reset
  // state between turns) would pass all of them. This pins that each subsequent
  // assistant turn appends its own PostToolUse line, in stream arrival order.
  it("accumulates PostToolUse lines across multiple assistant turns (separate stdout chunks)", () => {
    const { terminalId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    const turn = (tool: string) =>
      Buffer.from(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: tool, input: {} }] },
      }) + "\n");
    // Two distinct turns arriving as two separate stdout 'data' events.
    lastChild.stdout.emit("data", turn("Read"));
    lastChild.stdout.emit("data", turn("Bash"));

    const lines = readNdjson(path.join(sessionDir(), "events.ndjson"))
      .filter((e) => e.zana_terminal_id === terminalId);
    expect(lines).toHaveLength(2); // one per turn — second turn not dropped
    expect(lines.map((l) => l.tool_name)).toEqual(["Read", "Bash"]); // arrival order
    for (const ln of lines) expect(ln.hook_event_name).toBe("PostToolUse");
  });

  it("an assistant turn with no tool_use blocks writes NO tool lines (text-only is not a tool call)", () => {
    const { terminalId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    const textOnly = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "just thinking out loud" }] },
    }) + "\n";
    lastChild.stdout.emit("data", Buffer.from(textOnly));

    const lines = readNdjson(path.join(sessionDir(), "events.ndjson"))
      .filter((e) => e.zana_terminal_id === terminalId);
    expect(lines).toHaveLength(0);
  });

  it("REGRESSION: before the fix this file would be empty — assert it is NOT", () => {
    const { terminalId } = spawnHeadlessAgent(PROFILE, { prompt: "do work" });
    lastChild.stdout.emit("data", Buffer.from(assistantFrameWithTools()));

    const globalPath = path.join(sessionDir(), "events.ndjson");
    expect(fs.existsSync(globalPath)).toBe(true);
    const lines = readNdjson(globalPath).filter((e) => e.zana_terminal_id === terminalId);
    // The whole point of the ticket: a headless agent's tool events must be here.
    expect(lines.length).toBeGreaterThan(0);
  });
});
