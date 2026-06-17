// ITicketService — the contract for work-tracking tickets.
//
// Concrete impl: packages/work/src/tickets/service.ts (SQLite-backed via db.ts).
// Reached today through require("@zana-ai/core").tickets.service or the dispatch
// god-router. This interface captures the STABLE lifecycle surface so callers
// (MCP handlers, the watcher, the HTTP API) can depend on the contract; the
// concrete store (SQLite now, a remote one later) can be swapped behind it.
//
// Intentionally NOT exhaustive: fast-evolving helpers (epic/parent hierarchy,
// timelines, human-checkpoints) stay with the implementation until they
// stabilize. Add them here when they do.
//
// Type-only module — no runtime code.

import type { ServiceResult } from "./common";

export type TicketStatus =
  | "backlog" | "in-progress" | "review" | "rework" | "blocked" | "done" | "cancelled";
export type TicketPriority = "critical" | "high" | "medium" | "low";
export type ReviewPhase = "qa" | "architecture";

/** Review verdict kinds. INCONCLUSIVE = reviewer could not LOCATE the work on
 *  the inspected tree (e.g. it's on another branch/worktree) — not a failure. */
export type VerdictKind = "PASS" | "FAIL" | "READY" | "BLOCKED" | "INCONCLUSIVE";

/** Where an implementation landed, so a reviewer isn't blind to work committed
 *  off the checked-out HEAD. */
export interface WorkRef {
  branch?: string;
  commitRange?: string;
  worktree?: string;
}

/** Attestation evidence carried by an authorized completion — lets an
 *  orchestrator/human assert "verified-done on branch X" without re-entering a
 *  branch-blind reviewer. */
export interface CompletionEvidence {
  branch?: string;
  commitRange?: string;
  testResult?: string;
  attestedBy?: string;
}

export interface Ticket {
  id: string;
  title: string;
  description?: string;
  status: TicketStatus;
  priority: TicketPriority;
  reviewPhase?: ReviewPhase | null;
  reworkCount?: number;
  labels?: string[];
  blockedBy?: string[];
  assigneeProfileId?: string | null;
  workRef?: WorkRef | null;
  parentId?: string | null;
  [key: string]: unknown;
}

export interface TicketCreateParams {
  title: string;
  description?: string;
  priority?: TicketPriority;
  labels?: string[];
  blockedBy?: string[];
  sprintId?: string;
  createdBy?: string;
  parentId?: string | null;
}

export interface ITicketService {
  createTicket(params: TicketCreateParams): Ticket | { error: string };
  getTicket(ticketId: string): Ticket | null;
  listTickets(filter?: Record<string, unknown>): Ticket[];
  claimTicket(ticketId: string, agentId: string, agentName?: string, profileId?: string): ServiceResult<{ ticket: Ticket }>;
  updateStatus(ticketId: string, newStatus: TicketStatus, updatedBy: string): ServiceResult<{ ticket: Ticket }>;
  completeTicket(ticketId: string, resultSummary: string, completedBy: string, evidence?: CompletionEvidence): ServiceResult<{ ticket: Ticket }>;
  addComment(ticketId: string, authorId: string, authorName: string, body: string): ServiceResult<{ comment: unknown }>;
  updateReviewPhase(ticketId: string, phase: ReviewPhase, updatedBy: string): ServiceResult<{ ticket: Ticket }>;
  recordVerdict(ticketId: string, kind: VerdictKind, reason: string | null, reportedBy: string, profileLabel?: string): ServiceResult<{ ticketId: string; verdict: VerdictKind }>;
}
