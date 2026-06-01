import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const TICKETS_DIR = path.join(os.homedir(), ".zana", "tickets");
const SPRINTS_DIR = path.join(os.homedir(), ".zana", "sprints");

import * as ticketService from "@zana-ai/work/src/tickets/service.ts";

function cleanupTestFiles(prefix) {
  // Clean tickets (stored as directories with ticket.json inside)
  try {
    const entries = fs.readdirSync(TICKETS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      let data = null;
      if (entry.isDirectory()) {
        const ticketPath = path.join(TICKETS_DIR, entry.name, "ticket.json");
        try { data = JSON.parse(fs.readFileSync(ticketPath, "utf8")); } catch {}
      } else if (entry.name.endsWith(".json") && !entry.name.startsWith("_")) {
        try { data = JSON.parse(fs.readFileSync(path.join(TICKETS_DIR, entry.name), "utf8")); } catch {}
      }
      if (data && (data.title?.startsWith(prefix) || data.name?.startsWith(prefix))) {
        const fullPath = path.join(TICKETS_DIR, entry.name);
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    }
  } catch {}

  // Clean sprints (flat JSON files)
  try {
    const files = fs.readdirSync(SPRINTS_DIR);
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SPRINTS_DIR, f), "utf8"));
        if (data.title?.startsWith(prefix) || data.name?.startsWith(prefix)) {
          fs.unlinkSync(path.join(SPRINTS_DIR, f));
        }
      } catch {}
    }
  } catch {}
}

const BASE_PREFIX = `test-${Date.now()}`;
let PREFIX = BASE_PREFIX;

describe("ticket-service", () => {
  beforeEach(() => {
    // Unique per-test PREFIX to avoid cross-test contamination from
    // leftover tickets, recurring schedulers, or partial cleanups.
    PREFIX = `${BASE_PREFIX}-${crypto.randomUUID()}`;
    cleanupTestFiles(PREFIX);
  });

  afterEach(() => {
    cleanupTestFiles(PREFIX);
  });

  describe("ticket CRUD", () => {
    it("creates a ticket with correct defaults", () => {
      const ticket = ticketService.createTicket({
        title: `${PREFIX}-ticket-1`,
        description: "Test description",
        priority: "high",
        labels: ["test"],
        createdBy: "test-agent",
      });

      expect(ticket.id).toBeDefined();
      expect(ticket.title).toBe(`${PREFIX}-ticket-1`);
      expect(ticket.status).toBe("backlog");
      expect(ticket.priority).toBe("high");
      expect(ticket.labels).toEqual(["test"]);
      expect(ticket.assigneeId).toBeNull();
      expect(ticket.comments).toEqual([]);
    });

    it("lists and filters tickets", () => {
      ticketService.createTicket({ title: `${PREFIX}-a`, priority: "high", createdBy: "test" });
      ticketService.createTicket({ title: `${PREFIX}-b`, priority: "low", createdBy: "test" });

      const all = ticketService.listTickets({});
      const high = ticketService.listTickets({ priority: "high" });

      expect(all.filter((t) => t.title.startsWith(PREFIX)).length).toBe(2);
      expect(high.filter((t) => t.title.startsWith(PREFIX)).length).toBe(1);
    });

    it("gets a ticket by id", () => {
      const ticket = ticketService.createTicket({ title: `${PREFIX}-get`, createdBy: "test" });
      const found = ticketService.getTicket(ticket.id);
      expect(found.title).toBe(`${PREFIX}-get`);
    });

    it("deletes a ticket", () => {
      const ticket = ticketService.createTicket({ title: `${PREFIX}-del`, createdBy: "test" });
      const ok = ticketService.deleteTicket(ticket.id);
      expect(ok).toBe(true);
      expect(ticketService.getTicket(ticket.id)).toBeNull();
    });
  });

  describe("state machine", () => {
    it("claims a ticket from backlog", () => {
      const ticket = ticketService.createTicket({ title: `${PREFIX}-claim`, createdBy: "test" });
      const result = ticketService.claimTicket(ticket.id, "agent-1", "Agent One");

      expect(result.ok).toBe(true);
      expect(result.ticket.status).toBe("in-progress");
      expect(result.ticket.assigneeId).toBe("agent-1");
    });

    it("rejects invalid transitions", () => {
      const ticket = ticketService.createTicket({ title: `${PREFIX}-invalid`, createdBy: "test" });
      const result = ticketService.updateStatus(ticket.id, "done", "test");
      expect(result.error).toBeDefined();
    });

    it("allows valid transitions", () => {
      const ticket = ticketService.createTicket({ title: `${PREFIX}-valid`, createdBy: "test" });
      ticketService.claimTicket(ticket.id, "a", "A");
      const result = ticketService.updateStatus(ticket.id, "review", "test");
      expect(result.ok).toBe(true);
      expect(result.ticket.status).toBe("review");
    });

    it("completes a ticket with result", () => {
      const ticket = ticketService.createTicket({ title: `${PREFIX}-complete`, createdBy: "test" });
      const result = ticketService.completeTicket(ticket.id, "Done successfully", "agent");
      expect(result.ok).toBe(true);
      expect(result.ticket.status).toBe("done");
      expect(result.ticket.resultSummary).toBe("Done successfully");
      expect(result.ticket.closedAt).toBeDefined();
    });
  });

  describe("comments", () => {
    it("adds a comment to a ticket", () => {
      const ticket = ticketService.createTicket({ title: `${PREFIX}-comment`, createdBy: "test" });
      const result = ticketService.addComment(ticket.id, "agent-1", "Agent", "Progress update");

      expect(result.ok).toBe(true);
      expect(result.comment.body).toBe("Progress update");

      const updated = ticketService.getTicket(ticket.id);
      expect(updated.comments.length).toBe(1);
    });
  });

  describe("sprints", () => {
    it("creates and manages sprint lifecycle", () => {
      const sprint = ticketService.createSprint({
        name: `${PREFIX}-sprint`,
        teamId: "team-1",
        ticketIds: [],
      });

      expect(sprint.status).toBe("planning");

      const started = ticketService.startSprint(sprint.id);
      expect(started.ok).toBe(true);
      expect(started.sprint.status).toBe("active");

      const ended = ticketService.endSprint(sprint.id);
      expect(ended.ok).toBe(true);
      expect(ended.sprint.status).toBe("completed");
    });

    it("gets sprint board", () => {
      const sprint = ticketService.createSprint({ name: `${PREFIX}-board`, ticketIds: [] });
      const t1 = ticketService.createTicket({ title: `${PREFIX}-b1`, sprintId: sprint.id, createdBy: "test" });
      const t2 = ticketService.createTicket({ title: `${PREFIX}-b2`, sprintId: sprint.id, createdBy: "test" });
      ticketService.claimTicket(t2.id, "a", "A");

      const board = ticketService.getSprintBoard(sprint.id);
      expect(board.backlog.length).toBe(1);
      expect(board["in-progress"].length).toBe(1);
    });
  });
});
