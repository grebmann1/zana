/**
 * Ticket reconciliation sweeper — closes the long tail of orphaned
 * tickets that get stranded when both the orchestrator and the worker
 * crash without calling zana_ticket_complete. Without this, ghost
 * `in-progress` / `review` / `blocked` tickets accumulate forever
 * (we triaged 16 stale tickets on 2026-06-04 and closed 10 manually).
 *
 * Pattern mirrors `packages/core/src/agents/zombie-reaper.ts`:
 * module-level timer, opt-in via `moduleConfig.get()?.system`,
 * `_setTestSeams` for clock + dependency injection, exported
 * `sweepOnce()` for tests/ops to invoke directly.
 *
 * Eligible statuses: `in-progress`, `review`, `rework`, `blocked`.
 * `backlog` is NEVER swept — those are real queued items.
 */

import { lazyRequire } from "@zana-ai/contracts";
import type { IAgentManager } from "@zana-ai/contracts";

type Agent = { id: string; state: string };
type Ticket = {
  id: string;
  status: string;
  assigneeId: string | null;
  assigneeName: string | null;
  audit?: Array<{ timestamp: string }>;
  createdAt: string;
};
type StatusUpdateResult = { ok?: boolean; error?: string; ticket?: Ticket };

interface ModuleConfigShape {
  get(): { system?: any } | null;
}
// Agent registry is consumed through the published IAgentManager contract
// (@zana-ai/contracts), not an ad-hoc local shape — so work depends on the
// interface, not core's internal module layout. We only call listAgents() here.
interface BusShape {
  emit(type: string, payload: any): void;
}
interface TicketServiceShape {
  listTickets(filter?: { status?: string }): Ticket[];
  updateStatus(id: string, status: string, actor: string): StatusUpdateResult;
  addComment(id: string, authorId: string, authorName: string, body: string): any;
}

const moduleConfig = lazyRequire<ModuleConfigShape>(() => require("@zana-ai/core").modules.config);
const agentManager = lazyRequire<IAgentManager>(() => require("@zana-ai/core").agents.manager);
const coreEvents = lazyRequire<{ bus: BusShape }>(() => require("@zana-ai/core").events);
// `service` lives in this same package — direct relative require, no cycle.
function _ticketSvc(): TicketServiceShape { return require("./service"); }

const ELIGIBLE_STATUSES = ["in-progress", "review", "rework", "blocked"] as const;

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;        // 1 hour
const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

let timer: NodeJS.Timeout | null = null;

// Test seams — mirror zombie-reaper.
let now: () => number = () => Date.now();
let agentLister: () => Agent[] = () => agentManager.listAgents();
let ticketLister: (filter: { status: string }) => Ticket[] = (f) => _ticketSvc().listTickets(f);
let statusUpdater: (id: string, status: string, actor: string) => StatusUpdateResult =
  (id, s, a) => _ticketSvc().updateStatus(id, s, a);
let commenter: (id: string, authorId: string, authorName: string, body: string) => any =
  (id, ai, an, b) => _ticketSvc().addComment(id, ai, an, b);
let bus: BusShape = { emit: (type, payload) => coreEvents.bus.emit(type, payload) };
let configReader: () => any = () => {
  try { return moduleConfig.get()?.system; } catch { return undefined; }
};

export function _setTestSeams(opts: {
  now?: () => number;
  agentLister?: () => Agent[];
  ticketLister?: (filter: { status: string }) => Ticket[];
  statusUpdater?: (id: string, status: string, actor: string) => StatusUpdateResult;
  commenter?: (id: string, authorId: string, authorName: string, body: string) => any;
  bus?: BusShape;
  configReader?: () => any;
}) {
  if (opts.now) now = opts.now;
  if (opts.agentLister) agentLister = opts.agentLister;
  if (opts.ticketLister) ticketLister = opts.ticketLister;
  if (opts.statusUpdater) statusUpdater = opts.statusUpdater;
  if (opts.commenter) commenter = opts.commenter;
  if (opts.bus) bus = opts.bus;
  if (opts.configReader) configReader = opts.configReader;
}

export function _resetTestSeams() {
  now = () => Date.now();
  agentLister = () => agentManager.listAgents();
  ticketLister = (f) => _ticketSvc().listTickets(f);
  statusUpdater = (id, s, a) => _ticketSvc().updateStatus(id, s, a);
  commenter = (id, ai, an, b) => _ticketSvc().addComment(id, ai, an, b);
  bus = { emit: (type, payload) => coreEvents.bus.emit(type, payload) };
  configReader = () => {
    try { return moduleConfig.get()?.system; } catch { return undefined; }
  };
}

function getConfig() {
  const sys = configReader();
  return {
    enabled: sys?.ticketSweeperEnabled !== false,
    intervalMs: sys?.ticketSweeperIntervalMs ?? DEFAULT_INTERVAL_MS,
    staleThresholdMs: sys?.ticketStaleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
  };
}

function lastActivityMs(ticket: Ticket): number {
  const lastAudit = ticket.audit && ticket.audit.length > 0
    ? ticket.audit[ticket.audit.length - 1]
    : null;
  const iso = lastAudit?.timestamp || ticket.createdAt;
  const ms = Date.parse(iso);
  return isNaN(ms) ? 0 : ms;
}

type SweepReason = "stale-no-activity" | "stale-assignee-dead";

interface SweepDecision {
  ticket: Ticket;
  reason: SweepReason;
  hoursStale: number;
}

/** Run one sweep. Returns the summary of what happened. */
export function sweepOnce(): { swept: SweepDecision[]; skipped: number; total: number } {
  const cfg = getConfig();
  if (!cfg.enabled) return { swept: [], skipped: 0, total: 0 };

  // Build alive set. If listAgents throws (daemon not yet ready) treat
  // all assignees as dead — safer than skipping the sweep entirely,
  // because the in-progress/review path requires assignee-dead AND
  // staleness, so a partial answer can't lead to a false sweep.
  let alive: Set<string>;
  try {
    alive = new Set(agentLister().filter((a) => a && a.state !== "terminated").map((a) => a.id));
  } catch {
    alive = new Set();
  }

  const swept: SweepDecision[] = [];
  let skipped = 0;
  let total = 0;
  const nowMs = now();

  for (const status of ELIGIBLE_STATUSES) {
    let tickets: Ticket[] = [];
    try { tickets = ticketLister({ status }) || []; } catch { tickets = []; }
    total += tickets.length;

    for (const ticket of tickets) {
      try {
        const ageMs = nowMs - lastActivityMs(ticket);
        if (ageMs <= cfg.staleThresholdMs) { skipped++; continue; }

        let reason: SweepReason;
        if (status === "blocked") {
          reason = "stale-no-activity";
        } else {
          // in-progress / review / rework — must have a dead assignee.
          if (!ticket.assigneeId || alive.has(ticket.assigneeId)) {
            skipped++;
            continue;
          }
          reason = "stale-assignee-dead";
        }

        const hoursStale = Math.round(ageMs / 3600000);
        const summary =
          `Auto-cancelled by ticket-sweeper at ${new Date(nowMs).toISOString()}: ` +
          `stale for ${hoursStale}h, assignee ${ticket.assigneeName || "none"} not alive.`;
        const updateRes = statusUpdater(ticket.id, "cancelled", "ticket-sweeper");
        if (updateRes && updateRes.error) {
          process.stderr.write(`[ticket-sweeper] updateStatus failed for ${ticket.id}: ${updateRes.error}\n`);
          skipped++;
          continue;
        }
        commenter(ticket.id, "ticket-sweeper", "ticket-sweeper",
          summary + " — re-open via 'cancelled → backlog'.");
        bus.emit("ticket:swept", { ticketId: ticket.id, reason });
        swept.push({ ticket, reason, hoursStale });
        process.stderr.write(`[ticket-sweeper] swept ${ticket.id} reason=${reason} stale=${hoursStale}h\n`);
      } catch (err: any) {
        process.stderr.write(`[ticket-sweeper] sweep failed for ${ticket?.id}: ${err?.message || err}\n`);
        skipped++;
      }
    }
  }

  return { swept, skipped, total };
}

export function start(): () => void {
  const cfg = getConfig();
  if (!cfg.enabled || cfg.intervalMs <= 0) return () => {};
  // Initial sweep so backlog from a prior daemon run gets cleared promptly.
  try { sweepOnce(); } catch (err: any) {
    process.stderr.write(`[ticket-sweeper] initial sweep failed: ${err?.message || err}\n`);
  }
  timer = setInterval(() => {
    try { sweepOnce(); } catch (err: any) {
      process.stderr.write(`[ticket-sweeper] sweep failed: ${err?.message || err}\n`);
    }
  }, cfg.intervalMs);
  if (timer.unref) timer.unref();
  return stop;
}

export function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function _isRunning(): boolean {
  return timer !== null;
}
