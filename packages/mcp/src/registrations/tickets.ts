// Ticket CRUD + workflow transitions. Tickets are globally shared across all
// daemons in the workspace.

import type { ToolDomain } from "../types";

const env = (k: string, fallback: string) => process.env[k] || fallback;

export const tickets: ToolDomain = {
  tools: [
    {
      name: "zana_ticket_create",
      description: "Create a new ticket for tracking work. Tickets are globally shared across all daemons.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the ticket" },
          description: { type: "string", description: "Detailed description of the work" },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Priority level" },
          labels: { type: "array", items: { type: "string" }, description: "Tags/labels" },
          blockedBy: { type: "array", items: { type: "string" }, description: "IDs of tickets blocking this one" },
          sprintId: { type: "string", description: "Sprint to add this ticket to" },
        },
        required: ["title"],
      },
    },
    {
      name: "zana_ticket_list",
      description: "List/filter tickets. All tickets are globally shared.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["backlog", "in-progress", "review", "done", "cancelled"] },
          sprintId: { type: "string" },
          assigneeId: { type: "string" },
          label: { type: "string" },
        },
      },
    },
    {
      name: "zana_ticket_get",
      description: "Get full details of a specific ticket including comments and history.",
      inputSchema: {
        type: "object",
        properties: { ticketId: { type: "string", description: "Ticket ID" } },
        required: ["ticketId"],
      },
    },
    {
      name: "zana_ticket_claim",
      description: "Claim a ticket (assigns it to you and moves to in-progress). Works on backlog and rework tickets. Refuses if the ticket has open blockedBy dependencies — those must reach done/cancelled first.",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string", description: "Ticket ID to claim" },
          agentName: { type: "string", description: "Optional human-readable name to record on the ticket (e.g. 'worker-4'). Defaults to ZANA_AGENT_NAME env or 'Agent'." },
        },
        required: ["ticketId"],
      },
    },
    {
      name: "zana_ticket_claim_next",
      description:
        "Claim the highest-priority ready ticket — a backlog/rework ticket whose blockedBy dependencies are all done/cancelled — ordered by priority then age. This is the dependency-aware dispatcher: call it in a loop to execute a ticket graph in the correct order. Returns { ok: false, reason: 'none_ready' } when nothing is currently dispatchable.",
      inputSchema: {
        type: "object",
        properties: {
          agentName: { type: "string", description: "Optional human-readable name to record on the claimed ticket. Defaults to ZANA_AGENT_NAME env or 'Agent'." },
          sprintId: { type: "string", description: "Restrict selection to a single sprint (optional)." },
        },
      },
    },
    {
      name: "zana_ticket_list_ready",
      description:
        "List claimable tickets (backlog/rework with all blockedBy dependencies closed), ordered by the dispatch priority. Read-only — does not claim. Use to inspect what would run next.",
      inputSchema: {
        type: "object",
        properties: {
          sprintId: { type: "string", description: "Restrict to a single sprint (optional)." },
        },
      },
    },
    {
      name: "zana_ticket_update_status",
      description:
        "Move a ticket to a new status. Valid transitions: backlog→in-progress/cancelled, in-progress→review/done/backlog/cancelled, review→done/rework/cancelled, rework→in-progress/cancelled.",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          status: {
            type: "string",
            enum: ["backlog", "in-progress", "review", "rework", "blocked", "done", "cancelled"],
          },
        },
        required: ["ticketId", "status"],
      },
    },
    {
      name: "zana_ticket_comment",
      description: "Add a comment/update log to a ticket.",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          body: { type: "string", description: "Comment text" },
        },
        required: ["ticketId", "body"],
      },
    },
    {
      name: "zana_ticket_complete",
      description: "Mark a ticket as done with a result summary describing what was accomplished. Optionally attach evidence (branch, commit range, test result) — this is the authorized attestation path: it lets an orchestrator or human assert a ticket is verified-done on a specific branch and reconcile a stale/wrong review WITHOUT re-entering the reviewer. Works from any status.",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          resultSummary: { type: "string", description: "Summary of what was done" },
          evidence: {
            type: "object",
            description: "Proof the work is verified-done, recorded on the audit trail and folded into the ticket's workRef.",
            properties: {
              branch: { type: "string", description: "Git branch the work is on" },
              commitRange: { type: "string", description: "Commit sha or range, e.g. 'abc123' or 'main..0.8.3'" },
              testResult: { type: "string", description: "Test outcome, e.g. '1289 passed'" },
              attestedBy: { type: "string", description: "Who attested (orchestrator/human)" },
            },
          },
        },
        required: ["ticketId", "resultSummary"],
      },
    },
    {
      name: "zana_ticket_edit",
      description:
        "Edit a ticket's fields (title, description, priority, labels, type, sprintId). Only specified fields are updated.",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string", description: "Ticket ID to edit" },
          title: { type: "string", description: "New title (optional)" },
          description: { type: "string", description: "New description (optional)" },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "New priority (optional)" },
          labels: { type: "array", items: { type: "string" }, description: "New labels array (replaces existing)" },
          type: { type: "string", enum: ["bug", "feature", "chore", "spike"], description: "Ticket type (optional)" },
          sprintId: { type: "string", description: "Move to sprint (optional)" },
        },
        required: ["ticketId"],
      },
    },
    {
      name: "zana_ticket_update",
      description:
        "Update a ticket with progress, plan, status, review phase, or files changed. Workers and reviewers use this to report progress and advance the review pipeline.",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string", description: "Ticket ID to update" },
          status: {
            type: "string",
            enum: ["in-progress", "review", "rework", "blocked", "done"],
            description: "Transition to new status",
          },
          reviewPhase: {
            type: "string",
            enum: ["qa", "architecture"],
            description: "Advance the review phase (QA reviewer sets 'architecture' on pass)",
          },
          progress: { type: "string", description: "Progress note or review feedback" },
          planification: { type: "string", description: "Implementation plan (written before coding)" },
          resultSummary: { type: "string", description: "Final result summary" },
          filesChanged: { type: "array", items: { type: "string" }, description: "File paths modified/created" },
          workRef: {
            type: "object",
            description: "Where the implementation landed, so a reviewer isn't blind to work on a non-HEAD branch/worktree. Record this when you move a ticket to review.",
            properties: {
              branch: { type: "string", description: "Git branch the work was committed on" },
              commitRange: { type: "string", description: "Commit or range, e.g. 'abc123' or 'main..feature'" },
              worktree: { type: "string", description: "Path to the git worktree, if not the main checkout" },
            },
          },
        },
        required: ["ticketId"],
      },
    },
    {
      name: "zana_ticket_verdict",
      description:
        "Record a structured review verdict on a ticket. Preferred over ending your output with a 'VERDICT:' line — this is deterministic and not affected by surrounding text. PASS advances the review phase (qa→architecture) or completes the ticket; FAIL sends it to rework; READY (after rework) re-opens review; BLOCKED marks it blocked. INCONCLUSIVE leaves the ticket in review without transitioning — use it when you cannot LOCATE the implementation on the tree you inspected (e.g. it is on a different branch or worktree). Never report FAIL for work you simply could not find. Used by reviewer/rework agents spawned by the ticket automation pipeline.",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string", description: "Ticket ID being reviewed" },
          verdict: {
            type: "string",
            enum: ["PASS", "FAIL", "READY", "BLOCKED", "INCONCLUSIVE"],
            description: "PASS/FAIL for a review; READY/BLOCKED for a rework cycle; INCONCLUSIVE when the work could not be located on the inspected tree",
          },
          reason: { type: "string", description: "One-line reason (required for FAIL/BLOCKED/INCONCLUSIVE)" },
        },
        required: ["ticketId", "verdict"],
      },
    },
    {
      name: "zana_ticket_add_to_sprint",
      description: "Add a ticket to a sprint.",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          sprintId: { type: "string" },
        },
        required: ["ticketId", "sprintId"],
      },
    },
  ],

  handlers: {
    zana_ticket_create: (args, { callCore }) =>
      callCore("ticket_create", {
        title: args.title,
        description: args.description,
        priority: args.priority,
        labels: args.labels,
        blockedBy: args.blockedBy,
        sprintId: args.sprintId,
        createdBy: env("ZANA_TERMINAL_ID", "agent"),
      }),
    zana_ticket_list: async (args, { callCore }) => {
      const tickets = await callCore("ticket_list", {
        status: args.status,
        sprintId: args.sprintId,
        assigneeId: args.assigneeId,
        label: args.label,
      });
      if (!Array.isArray(tickets)) return tickets;
      return tickets.map((t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        assigneeId: t.assigneeId,
        assigneeName: t.assigneeName,
        sprintId: t.sprintId,
        labels: t.labels,
        type: t.type,
        reviewPhase: t.reviewPhase,
        reworkCount: t.reworkCount,
        blockedBy: t.blockedBy,
        commentCount: Array.isArray(t.comments) ? t.comments.length : 0,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
    },
    zana_ticket_get: (args, { callCore }) => callCore("ticket_get", { ticketId: args.ticketId }),
    zana_ticket_claim: (args, { callCore }) =>
      callCore("ticket_claim", {
        ticketId: args.ticketId,
        agentId: env("ZANA_TERMINAL_ID", "agent"),
        agentName: args.agentName || env("ZANA_AGENT_NAME", "Agent"),
        profileId: process.env.ZANA_PROFILE_ID || null,
      }),
    zana_ticket_claim_next: (args, { callCore }) =>
      callCore("ticket_claim_next", {
        agentId: env("ZANA_TERMINAL_ID", "agent"),
        agentName: args.agentName || env("ZANA_AGENT_NAME", "Agent"),
        profileId: process.env.ZANA_PROFILE_ID || null,
        sprintId: args.sprintId,
      }),
    zana_ticket_list_ready: async (args, { callCore }) => {
      const tickets = await callCore("ticket_list_ready", { sprintId: args.sprintId });
      if (!Array.isArray(tickets)) return tickets;
      return tickets.map((t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        sprintId: t.sprintId,
        blockedBy: t.blockedBy,
        createdAt: t.createdAt,
      }));
    },
    zana_ticket_update: (args, { callCore }) =>
      callCore("ticket_update", {
        ticketId: args.ticketId,
        status: args.status,
        reviewPhase: args.reviewPhase,
        progress: args.progress,
        planification: args.planification,
        resultSummary: args.resultSummary,
        filesChanged: args.filesChanged,
        workRef: args.workRef,
        agentId: env("ZANA_TERMINAL_ID", "agent"),
        agentName: env("ZANA_AGENT_NAME", "Agent"),
      }),
    zana_ticket_update_status: (args, { callCore }) =>
      callCore("ticket_update_status", {
        ticketId: args.ticketId,
        status: args.status,
        updatedBy: env("ZANA_TERMINAL_ID", "agent"),
      }),
    zana_ticket_comment: (args, { callCore }) =>
      callCore("ticket_comment", {
        ticketId: args.ticketId,
        body: args.body,
        authorId: env("ZANA_TERMINAL_ID", "agent"),
        authorName: env("ZANA_AGENT_NAME", "Agent"),
      }),
    zana_ticket_complete: async (args, { callCore }) => {
      const result: any = await callCore("ticket_complete", {
        ticketId: args.ticketId,
        resultSummary: args.resultSummary,
        completedBy: env("ZANA_TERMINAL_ID", "agent"),
        evidence: args.evidence,
      });
      // Slim payload — full ticket (description + audit + comments) is large
      // and the caller already knows what they completed. Hosts that need
      // the full record can call zana_ticket_get afterwards.
      const t = result?.ticket;
      return {
        ok: result?.ok ?? true,
        ticketId: t?.id || args.ticketId,
        status: t?.status || "done",
        closedAt: t?.closedAt || null,
      };
    },
    zana_ticket_edit: (args, { callCore }) =>
      callCore("ticket_edit", {
        ticketId: args.ticketId,
        title: args.title,
        description: args.description,
        priority: args.priority,
        labels: args.labels,
        type: args.type,
        sprintId: args.sprintId,
        updatedBy: env("ZANA_TERMINAL_ID", "agent"),
      }),
    zana_ticket_verdict: (args, { callCore }) =>
      callCore("ticket_verdict", {
        ticketId: args.ticketId,
        verdict: args.verdict,
        reason: args.reason,
        reportedBy: env("ZANA_TERMINAL_ID", "agent"),
        profileLabel: process.env.ZANA_PROFILE_ID || env("ZANA_AGENT_NAME", "reviewer"),
      }),
    zana_ticket_add_to_sprint: (args, { callCore }) =>
      callCore("ticket_add_to_sprint", { ticketId: args.ticketId, sprintId: args.sprintId }),
  },
};
