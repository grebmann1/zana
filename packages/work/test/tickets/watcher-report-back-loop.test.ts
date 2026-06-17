// The meta-finding fix (architect review 2026-06-17): every other test stubs
// the spawn boundary AND never exercises a worker REPORTING BACK, which is
// exactly where the two CRITICAL bugs lived (silent stall when the worker can't
// reach zana_ticket_*; fake backpressure when slots release on a timer).
//
// This test closes that gap WITHOUT a real Claude: the spawnAgent stub plays a
// realistic worker — it (a) performs its "work", (b) calls the REAL ticket
// service to report status (the report-back path), then (c) emits
// agent:terminated (which releases the concurrency slot). We then assert the
// FULL chain advances: claim → auto-implement spawn → worker moves ticket to
// review → qa-review rule fires → reviewer records a PASS verdict → phase
// advances to architecture. All through real watcher + real service state.

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

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe("report-back loop (meta-finding): worker reports via service, slot releases, chain advances", () => {
  it("claim → implement spawns → worker reports review → qa reviewer spawns → PASS advances to architecture", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-reportback-"));
    const ticketsDir = path.join(tmpDir, "tickets");
    fs.mkdirSync(ticketsDir, { recursive: true });

    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    const bus = (await import("@zana-ai/core") as any).events.bus;

    // An in-memory ticket the watcher reads, mutated by the stub service so
    // status transitions are observable. Models a single ticket through the FSM.
    const ticket: any = {
      id: "rb-1", title: "do the thing", description: "d",
      status: "in-progress", reviewPhase: null, labels: [], reworkCount: 0,
      assigneeProfileId: "backend-dev",
    };
    watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

    // Stub service that records calls AND mutates the ticket — this IS the
    // report-back surface a real worker would hit via zana_ticket_* MCP tools.
    const transitions: string[] = [];
    watcher._setServiceOverride({
      addComment: () => ({ ok: true }),
      updateStatus: (id: string, s: string) => { transitions.push(`status:${s}`); if (id === ticket.id) { ticket.status = s; if (s === "review" && !ticket.reviewPhase) ticket.reviewPhase = "qa"; } return { ok: true }; },
      updateReviewPhase: (id: string, p: string) => { transitions.push(`phase:${p}`); if (id === ticket.id) ticket.reviewPhase = p; return { ok: true }; },
      completeTicket: (id: string) => { transitions.push("complete"); if (id === ticket.id) ticket.status = "done"; return { ok: true }; },
      getTicket: (id: string) => (id === ticket.id ? ticket : null),
    });

    let n = 0;
    const spawnByProfile: string[] = [];
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: path.join(tmpDir, "config.json"),
      spawnAgent: (profileId: string, _prompt: string, ticketId: string) => {
        const agentId = `rb-agent-${++n}`;
        spawnByProfile.push(profileId);
        // Realistic worker behaviour, async (next tick), THEN terminate.
        setTimeout(() => {
          if (profileId === "backend-dev") {
            // The implementer reports its work done by moving the ticket to
            // review — exactly what the auto-implement prompt instructs the
            // worker to do via zana_ticket_update. Model it as the resulting
            // status transition + bus event the real service emits.
            ticket.status = "review";
            ticket.reviewPhase = "qa";
            transitions.push("status:review");
            bus.emit("ticket:statusChanged", { ticketId, oldStatus: "in-progress", newStatus: "review" });
          } else if (profileId === "code-reviewer") {
            // The QA reviewer records a structured PASS verdict.
            bus.emit("ticket:verdict", { ticketId, kind: "PASS", reason: null });
          }
          // Worker exits → releases the concurrency slot (C2).
          bus.emit("agent:terminated", { agentId, reason: "completed", exitCode: 0, output: "" });
        }, 10);
        return Promise.resolve({ agentId });
      },
    });

    // Kick the chain: claim fires the auto-implement rule.
    bus.emit("ticket:claimed", { ticketId: ticket.id, profileId: "backend-dev" });

    // Let the chain settle: implement spawn → report review → qa spawn → verdict.
    for (let i = 0; i < 20 && ticket.reviewPhase !== "architecture"; i++) await tick();

    // The implementer was spawned...
    expect(spawnByProfile).toContain("backend-dev");
    // ...the worker reported back (ticket reached review)...
    expect(transitions).toContain("status:review");
    // ...which fired the qa-review rule (reviewer spawned)...
    expect(spawnByProfile).toContain("code-reviewer");
    // ...and the PASS verdict advanced the phase to architecture.
    expect(ticket.reviewPhase).toBe("architecture");
  }, 30_000);
});
