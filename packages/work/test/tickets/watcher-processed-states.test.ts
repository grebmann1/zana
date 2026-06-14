// Tests for the _getProcessedStates() accessor exported from watcher.ts.
//
// The watcher maintains a `processedStates` Map<ticketId, string> that records
// the last-seen (status, reviewPhase) JSON key for each ticket. This map drives
// the LEGACY_DEDUP_EVENTS guard: if a ticket's state key hasn't changed since the
// last event, checkTicket() skips rule-firing — preventing the same review cycle
// from re-triggering on a redundant bus emit.
//
// _getProcessedStates() is exported specifically so integration tests can verify
// in-process bus delivery without coupling to private module internals.
//
// Covered behaviours:
//   • map is empty after _resetDedup()
//   • ticket:statusChanged (a LEGACY_DEDUP_EVENT) populates the map
//   • stored value encodes { status, reviewPhase } as a JSON string
//   • absent reviewPhase is stored as null (not undefined)
//   • _resetDedup() clears the map back to empty
//   • ticket:commented (NOT a LEGACY_DEDUP_EVENT) does NOT add an entry

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string | null = null;
let watcher: any = null;

afterEach(() => {
  if (watcher) {
    try { if (watcher.isRunning()) watcher.stop(); } catch {}
    try { watcher._resetDedup(); } catch {}
    try { watcher._setReadTicketOverride(null); } catch {}
  }
  watcher = null;
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  tmpDir = null;
});

async function setupWatcher(ticket: any) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-proc-states-"));
  const ticketsDir = path.join(tmpDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });

  watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
  try { if (watcher.isRunning()) watcher.stop(); } catch {}
  watcher._resetDedup();
  watcher._setReadTicketOverride((id: string) => (id === ticket.id ? ticket : null));

  watcher.init({
    ticketsDirectory: ticketsDir,
    configPath: "/nonexistent/automation.json",
    spawnAgent: () => Promise.resolve({ agentId: `fake-${Date.now()}` }),
  });

  return (await import("@zana-ai/core") as any).events.bus;
}

describe("_getProcessedStates()", () => {
  it("returns an empty map after _resetDedup()", async () => {
    watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
    watcher._resetDedup();
    expect(watcher._getProcessedStates().size).toBe(0);
  });

  it("adds an entry after ticket:statusChanged fires and debounce settles", async () => {
    const ticket: any = { id: `T-ps-sc-${Date.now()}`, status: "review", reviewPhase: "qa", labels: [] };
    const bus = await setupWatcher(ticket);

    bus.emit("ticket:statusChanged", { ticketId: ticket.id, oldStatus: "in-progress", newStatus: "review" });
    await new Promise((r) => setTimeout(r, 300)); // 150 ms debounce + buffer

    expect(watcher._getProcessedStates().has(ticket.id)).toBe(true);
    expect(JSON.parse(watcher._getProcessedStates().get(ticket.id))).toEqual({ status: "review", reviewPhase: "qa" });
  });

  it("stores reviewPhase as null when ticket.reviewPhase is absent", async () => {
    const ticket: any = { id: `T-ps-null-${Date.now()}`, status: "done", labels: [] };
    const bus = await setupWatcher(ticket);

    bus.emit("ticket:statusChanged", { ticketId: ticket.id, oldStatus: "in-progress", newStatus: "done" });
    await new Promise((r) => setTimeout(r, 300));

    expect(JSON.parse(watcher._getProcessedStates().get(ticket.id))).toEqual({ status: "done", reviewPhase: null });
  });

  it("clears the map after _resetDedup() is called", async () => {
    const ticket: any = { id: `T-ps-clr-${Date.now()}`, status: "done", reviewPhase: null, labels: [] };
    const bus = await setupWatcher(ticket);

    bus.emit("ticket:completed", { ticketId: ticket.id, completedBy: "agent-1" });
    await new Promise((r) => setTimeout(r, 300));

    expect(watcher._getProcessedStates().size).toBeGreaterThan(0);

    watcher._resetDedup();
    expect(watcher._getProcessedStates().size).toBe(0);
  });

  it("does NOT add an entry for ticket:commented (not a LEGACY_DEDUP_EVENT)", async () => {
    const ticket: any = { id: `T-ps-cmt-${Date.now()}`, status: "in-progress", reviewPhase: null, labels: [] };
    const bus = await setupWatcher(ticket);
    watcher._resetDedup(); // ensure clean slate

    bus.emit("ticket:commented", { ticketId: ticket.id, authorId: "user-1", body: "LGTM" });
    await new Promise((r) => setTimeout(r, 300));

    expect(watcher._getProcessedStates().has(ticket.id)).toBe(false);
  });
});
