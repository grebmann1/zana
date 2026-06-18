// #1 — agent-lifecycle → ticket crash recovery in the watcher.
//
// When a ticket-driven agent terminates with reason="errored" (crash / OOM /
// exhausted transient retries) the watcher must promptly recover the stranded
// ticket via service.recoverStuckTicket — instead of leaving it wedged in
// in-progress until the 24h sweeper. A "completed"/"killed"/"daemon-restart"
// terminate is NOT a crash and must not recover.
//
// Uses _trackTicketForTest to register a fire-and-forget implementer's
// agent→ticket mapping without a real spawn, and a service override so no real
// SQLite store is touched.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let watcher: any = null;
let tmpDir: string | null = null;

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

async function bootWatcher() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-watcher-recover-"));
  const ticketsDir = path.join(tmpDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  watcher = await import("@zana-ai/work/src/tickets/watcher.ts");
  const bus = (await import("@zana-ai/core") as any).events.bus;
  return { ticketsDir, bus };
}

describe("watcher crash recovery", () => {
  it("recovers a stranded ticket when its agent terminates with reason=errored", async () => {
    const { ticketsDir, bus } = await bootWatcher();
    const calls: any[] = [];
    const svc = {
      recoverStuckTicket: (id: string, reason: string, by: string) => {
        calls.push(["recover", id, reason, by]);
        return { ok: true, recovered: true, from: "in-progress" };
      },
    };
    watcher._setServiceOverride(svc);
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "unused" }),
    });

    watcher._trackTicketForTest("agent-x", "ticket-x");
    bus.emit("agent:terminated", { agentId: "agent-x", reason: "errored", error: "boom" });
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe("ticket-x");
    expect(calls[0][2]).toMatch(/errored/);
  });

  it("does NOT recover on a clean completed terminate", async () => {
    const { ticketsDir, bus } = await bootWatcher();
    const calls: any[] = [];
    watcher._setServiceOverride({
      recoverStuckTicket: (id: string) => { calls.push(id); return { ok: true, recovered: true }; },
    });
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "unused" }),
    });

    watcher._trackTicketForTest("agent-ok", "ticket-ok");
    bus.emit("agent:terminated", { agentId: "agent-ok", reason: "completed", exitCode: 0 });
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.length).toBe(0);
  });

  it("does NOT recover a killed (operator) terminate", async () => {
    const { ticketsDir, bus } = await bootWatcher();
    const calls: any[] = [];
    watcher._setServiceOverride({
      recoverStuckTicket: (id: string) => { calls.push(id); return { ok: true, recovered: true }; },
    });
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "unused" }),
    });

    watcher._trackTicketForTest("agent-k", "ticket-k");
    bus.emit("agent:terminated", { agentId: "agent-k", reason: "killed" });
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.length).toBe(0);
  });

  it("survives a throwing recoverStuckTicket and stays running", async () => {
    const { ticketsDir, bus } = await bootWatcher();
    watcher._setServiceOverride({
      recoverStuckTicket: () => { throw new Error("store down"); },
    });
    watcher.init({
      ticketsDirectory: ticketsDir,
      configPath: "/nonexistent/automation.json",
      spawnAgent: () => Promise.resolve({ agentId: "unused" }),
    });

    watcher._trackTicketForTest("agent-t", "ticket-t");
    expect(() =>
      bus.emit("agent:terminated", { agentId: "agent-t", reason: "errored" }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(watcher.isRunning()).toBe(true);
  });
});
