// Unit tests for the notifyChange() listener fan-out in agents/lifecycle.ts.
//
// The existing lifecycle-write-listen.test.ts covers onAgentsChange()'s
// subscribe/unsubscribe surface but explicitly states it "cannot trivially
// force a notifyChange without spawning a real process" — so the most
// important behaviour was left unverified:
//
//   1. A registered listener is actually INVOKED, and receives the live
//      agents snapshot (an array containing the newly-spawned agent).
//   2. notifyChange isolates a throwing listener (try/catch + console.warn)
//      so one bad callback cannot starve the others.
//   3. An unsubscribed listener stops receiving notifications.
//
// Strategy: reuse the headless-spawn mocking pattern (mock ./spawner +
// ./model-router so no real process spawns). spawnHeadlessAgent() calls
// notifyChange() synchronously, which fans out to every changeListener with
// listAgents() as the snapshot — giving us a deterministic way to trigger it.
//
// No real spawning, no PTY, no network — fully deterministic.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.pid = 8888;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: false };
  child.kill = vi.fn();
  return child;
}

vi.mock("@zana-ai/core/src/agents/spawner.ts", () => ({
  buildInteractiveCommand: vi.fn(() => ({ command: "echo", args: [] })),
  spawnHeadless: vi.fn(() => makeFakeChild()),
}));

vi.mock("@zana-ai/core/src/agents/model-router.ts", () => ({
  selectModel: vi.fn(() => "claude-haiku-routed"),
  TIERS: {},
}));

import {
  spawnHeadlessAgent,
  onAgentsChange,
} from "@zana-ai/core/src/agents/lifecycle.ts";
import * as moduleConfig from "@zana-ai/core/src/modules/config.ts";

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-notify-change-test-"));
  moduleConfig.setConfigPath(path.join(tmpDir, "config.json"));
});

const subs: Array<() => void> = [];
afterEach(() => {
  subs.forEach((u) => { try { u(); } catch {} });
  subs.length = 0;
});

const PROFILE = {
  id: "tester",
  displayName: "Tester",
  icon: "🧪",
  category: "general",
};

describe("notifyChange — listener fan-out", () => {
  it("invokes a registered listener with a snapshot containing the new agent", () => {
    const snapshots: any[][] = [];
    subs.push(onAgentsChange((snap) => { snapshots.push(snap); }));

    const { agentId } = spawnHeadlessAgent(PROFILE, { prompt: "x" });

    // The listener fires synchronously during spawnHeadlessAgent → notifyChange.
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const latest = snapshots[snapshots.length - 1];
    expect(Array.isArray(latest)).toBe(true);
    expect(latest.some((a) => a.id === agentId)).toBe(true);
  });

  it("isolates a throwing listener so later listeners still run", () => {
    const origWarn = console.warn;
    const warns: any[] = [];
    console.warn = (...args: any[]) => warns.push(args);

    let goodCalled = 0;
    subs.push(onAgentsChange(() => { throw new Error("boom"); }));
    subs.push(onAgentsChange(() => { goodCalled++; }));

    try {
      // Must not throw despite the first listener blowing up.
      expect(() => spawnHeadlessAgent(PROFILE, { prompt: "x" })).not.toThrow();
    } finally {
      console.warn = origWarn;
    }

    // The well-behaved listener registered after the thrower still ran.
    expect(goodCalled).toBeGreaterThanOrEqual(1);
    // The thrown error was caught and surfaced as a warning, not propagated.
    expect(warns.flat().join(" ")).toMatch(/listener callback error|boom/);
  });

  it("stops notifying a listener after it is unsubscribed", () => {
    let calls = 0;
    const unsub = onAgentsChange(() => { calls++; });

    spawnHeadlessAgent(PROFILE, { prompt: "x" });
    const afterFirstSpawn = calls;
    expect(afterFirstSpawn).toBeGreaterThanOrEqual(1);

    unsub();

    spawnHeadlessAgent(PROFILE, { prompt: "x" });
    // No further invocations after unsubscribe.
    expect(calls).toBe(afterFirstSpawn);
  });
});
