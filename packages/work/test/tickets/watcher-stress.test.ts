// HEAVY stress + adversarial tests for the orchestration pipeline. These push
// the real watcher (real DEFAULT_RULES, real EventEmitter bus, real queue /
// dedup / concurrency / rework-cap logic) under load and hostile input, with
// only the process-spawn boundary stubbed. Goal: surface races, double-fires,
// silent drops, and rework-loop runaway.

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-stress-"));
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
      // Model a real (fast) agent: it runs, then terminates — which is what
      // releases the concurrency slot now (C2). Without emitting this the queue
      // would correctly wedge after MAX_CONCURRENT spawns until the backstop.
      setTimeout(() => bus.emit("agent:terminated", { agentId, reason: "completed", exitCode: 0, output: "" }), 10);
      return Promise.resolve({ agentId });
    },
  });
  return { bus, spawns };
}

const tick = (ms = 2600) => new Promise((r) => setTimeout(r, ms));

describe("STRESS: orchestration pipeline under load + hostile input", () => {
  it("100 bug tickets created in a burst each get exactly one triage spawn (no drops, no dups)", async () => {
    const { bus, spawns } = await boot();
    const store: Record<string, any> = {};
    watcher._setReadTicketOverride((id: string) => store[id] || null);

    const N = 100;
    for (let i = 0; i < N; i++) {
      const id = `bug-${i}`;
      store[id] = { id, title: `bug ${i}`, description: "d", status: "backlog", labels: ["bug"], reviewPhase: null, reworkCount: 0, assigneeProfileId: null };
      bus.emit("ticket:created", { ticketId: id });
    }
    // Drain: 100 spawns / 3 concurrent slots * 2s release ≈ 67s worst case; the
    // queue is serviced as slots free, so poll until quiescent.
    let prev = -1;
    for (let i = 0; i < 60 && spawns.length !== prev; i++) { prev = spawns.length; await tick(2300); }

    const triage = spawns.filter((s) => s.profileId === "triage-scout");
    const ids = new Set(triage.map((s) => s.ticketId));
    expect(triage.length).toBe(N);          // no drops
    expect(ids.size).toBe(N);               // no duplicates
  }, 180_000);

  it("duplicate-emit storm: same event fired 50x collapses to a single spawn (dedup holds)", async () => {
    const { bus, spawns } = await boot();
    const store: Record<string, any> = {};
    watcher._setReadTicketOverride((id: string) => store[id] || null);

    store["dup-1"] = { id: "dup-1", title: "x", description: "d", status: "in-progress", labels: [], reviewPhase: null, reworkCount: 0, assigneeProfileId: "backend-dev" };
    for (let i = 0; i < 50; i++) bus.emit("ticket:claimed", { ticketId: "dup-1", profileId: "backend-dev" });
    await tick();

    expect(spawns.filter((s) => s.ticketId === "dup-1")).toHaveLength(1);
  }, 30_000);

  it("rework runaway is capped: a ticket failing review forever is auto-blocked, not spawned infinitely", async () => {
    const { bus, spawns } = await boot();
    const store: Record<string, any> = {};
    let blocked = false;
    const comments: any[] = [];
    watcher._setReadTicketOverride((id: string) => store[id] || null);
    watcher._setServiceOverride({
      addComment: (...a: any[]) => { comments.push(a); return { ok: true }; },
      updateStatus: (id: string, s: string) => { if (id === "rw-1" && s === "blocked") blocked = true; if (store[id]) store[id].status = s; return { ok: true }; },
      updateReviewPhase: () => ({ ok: true }),
      completeTicket: () => ({ ok: true }),
      getTicket: (id: string) => store[id] || null,
    });

    // Ticket already at the rework cap → executeAutomation must short-circuit to
    // markBlocked instead of spawning a worker.
    store["rw-1"] = { id: "rw-1", title: "loops", description: "d", status: "rework", labels: [], reviewPhase: null, reworkCount: 3, assigneeProfileId: "backend-dev" };
    bus.emit("ticket:statusChanged", { ticketId: "rw-1", oldStatus: "review", newStatus: "rework" });
    await tick();

    expect(blocked).toBe(true);
    expect(spawns.filter((s) => s.ticketId === "rw-1")).toHaveLength(0); // NOT spawned
  }, 30_000);

  it("malformed/structured verdict mix: a structured verdict wins and suppresses a conflicting text line", async () => {
    const { bus } = await boot();
    const store: Record<string, any> = {};
    const transitions: any[] = [];
    watcher._setReadTicketOverride((id: string) => store[id] || null);
    watcher._setServiceOverride({
      addComment: () => ({ ok: true }),
      updateStatus: (id: string, s: string) => { transitions.push(["status", id, s]); return { ok: true }; },
      updateReviewPhase: (id: string, p: string) => { transitions.push(["phase", id, p]); return { ok: true }; },
      completeTicket: (id: string) => { transitions.push(["complete", id]); return { ok: true }; },
      getTicket: (id: string) => store[id] || null,
    });
    store["v-1"] = { id: "v-1", title: "x", description: "d", status: "review", labels: [], reviewPhase: "qa", reworkCount: 0, assigneeProfileId: "backend-dev" };

    // Structured PASS arrives (advances qa→architecture)...
    bus.emit("ticket:verdict", { ticketId: "v-1", kind: "PASS" });
    await tick(50);
    // ...then the SAME agent terminates with a CONFLICTING text "VERDICT: FAIL".
    watcher._trackForTest("a-dup", store["v-1"], { action: { spawnProfile: "code-reviewer", expectVerdict: true } });
    bus.emit("agent:terminated", { agentId: "a-dup", reason: "completed", exitCode: 0, output: "actually broken\nVERDICT: FAIL — regression" });
    await tick(50);

    const phaseAdvances = transitions.filter((t) => t[0] === "phase");
    const reworks = transitions.filter((t) => t[0] === "status" && t[2] === "rework");
    expect(phaseAdvances).toHaveLength(1);  // the structured PASS applied
    expect(reworks).toHaveLength(0);        // the conflicting text FAIL was suppressed
  }, 30_000);

  it("interleaved mixed-event flood across many tickets routes each to the correct profile", async () => {
    const { bus, spawns } = await boot();
    const store: Record<string, any> = {};
    watcher._setReadTicketOverride((id: string) => store[id] || null);

    // 20 of each kind, interleaved, fired as fast as possible.
    const kinds = 20;
    for (let i = 0; i < kinds; i++) {
      const bugId = `f-bug-${i}`, claimId = `f-clm-${i}`, escId = `f-esc-${i}`, qaId = `f-qa-${i}`;
      store[bugId] = { id: bugId, title: "b", description: "d", status: "backlog", labels: ["bug"], reviewPhase: null, reworkCount: 0, assigneeProfileId: null };
      store[claimId] = { id: claimId, title: "c", description: "d", status: "in-progress", labels: [], reviewPhase: null, reworkCount: 0, assigneeProfileId: "backend-dev" };
      store[escId] = { id: escId, title: "e", description: "d", status: "backlog", labels: ["awaiting-decision"], reviewPhase: null, reworkCount: 0, assigneeProfileId: "architect" };
      store[qaId] = { id: qaId, title: "q", description: "d", status: "review", labels: [], reviewPhase: "qa", reworkCount: 0, assigneeProfileId: "backend-dev" };
      bus.emit("ticket:created", { ticketId: bugId });
      bus.emit("ticket:claimed", { ticketId: claimId, profileId: "backend-dev" });
      bus.emit("ticket:escalated", { ticketId: escId });
      bus.emit("ticket:statusChanged", { ticketId: qaId, oldStatus: "in-progress", newStatus: "review" });
    }
    let prev = -1;
    for (let i = 0; i < 60 && spawns.length !== prev; i++) { prev = spawns.length; await tick(2300); }

    const profById = new Map(spawns.map((s) => [s.ticketId, s.profileId]));
    for (let i = 0; i < kinds; i++) {
      expect(profById.get(`f-bug-${i}`)).toBe("triage-scout");
      expect(profById.get(`f-clm-${i}`)).toBe("backend-dev");
      expect(profById.get(`f-esc-${i}`)).toBe("architect");
      expect(profById.get(`f-qa-${i}`)).toBe("code-reviewer");
    }
    expect(spawns.length).toBe(kinds * 4); // exactly one per event, none lost
  }, 180_000);
});
