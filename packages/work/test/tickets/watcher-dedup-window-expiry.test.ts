// Tests the EXPIRY side of the short-window duplicate-fire suppression in
// packages/work/src/tickets/watcher.ts (isDuplicateFire + the opportunistic
// sweep of `recentlyFired`).
//
// watcher-stress.test.ts already proves the COLLAPSE direction: 50 identical
// emits within DEDUP_TTL_MS produce a single spawn. The complementary
// guarantee — that once the 2s window lapses an identical event is allowed to
// fire a NEW spawn (the entry is swept, suppression is not permanent) — had no
// coverage. A regression in the sweep loop would silently turn the dedup map
// into a permanent block and drop legitimate re-fires; this test pins it.
//
// Deterministic: only the process-spawn boundary is stubbed (no real Claude,
// no SQLite). The single real-time wait past DEDUP_TTL_MS is in line with the
// multi-second ticks the sibling stress suite already uses.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string | null = null;
let watcher: any = null;

afterEach(() => {
  if (watcher) {
    try { watcher._setServiceOverride(null); } catch {}
    try { watcher._setReadTicketOverride(null); } catch {}
    try { if (watcher.isRunning()) watcher.stop(); } catch {}
    try { watcher._resetDedup(); } catch {}
  }
  watcher = null;
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  tmpDir = null;
});

async function boot() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-dedup-"));
  const ticketsDir = path.join(tmpDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
  const bus = (await import("@zana-ai/core") as any).events.bus;
  const spawns: any[] = [];
  watcher.init({
    ticketsDirectory: ticketsDir,
    configPath: path.join(tmpDir, "config.json"),
    spawnAgent: (profileId: string, _p: string, ticketId: string) => {
      const agentId = `a-${spawns.length + 1}`;
      spawns.push({ profileId, ticketId, at: spawns.length });
      // Model a real (fast) agent that terminates, releasing the slot.
      setTimeout(() => bus.emit("agent:terminated", { agentId, reason: "completed", exitCode: 0, output: "" }), 10);
      return Promise.resolve({ agentId });
    },
  });
  return { bus, spawns };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watcher dedup window expiry", () => {
  it("re-fires an identical event after DEDUP_TTL_MS elapses (sweep is not a permanent block)", async () => {
    const { bus, spawns } = await boot();
    const store: Record<string, any> = {};
    watcher._setReadTicketOverride((id: string) => store[id] || null);

    // ticket:claimed is intentionally NOT in LEGACY_DEDUP_EVENTS, so the
    // processedStates gate doesn't interfere — only the short-window
    // recentlyFired dedup governs whether the auto-implement rule re-fires.
    store["d-1"] = {
      id: "d-1", title: "x", description: "d", status: "in-progress",
      labels: [], reviewPhase: null, reworkCount: 0, assigneeProfileId: "backend-dev",
    };

    // First emit fires exactly one spawn.
    bus.emit("ticket:claimed", { ticketId: "d-1", profileId: "backend-dev" });
    await tick(400);
    expect(spawns.filter((s) => s.ticketId === "d-1")).toHaveLength(1);

    // A duplicate inside the window is still swallowed.
    bus.emit("ticket:claimed", { ticketId: "d-1", profileId: "backend-dev" });
    await tick(400);
    expect(spawns.filter((s) => s.ticketId === "d-1")).toHaveLength(1);

    // Wait past DEDUP_TTL_MS (2000ms) so the entry is swept on the next check.
    await tick(2300);

    // The same event now fires a fresh spawn.
    bus.emit("ticket:claimed", { ticketId: "d-1", profileId: "backend-dev" });
    await tick(400);
    expect(spawns.filter((s) => s.ticketId === "d-1")).toHaveLength(2);
  }, 30_000);
});
