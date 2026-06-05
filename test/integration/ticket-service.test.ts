import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as core from "@zana-ai/core";

import * as ticketService from "@zana-ai/work/src/tickets/service.ts";

const wcDist: any = (core as any).project.workspaceContext;

// db.ts caches the SQLite connection at module level, so we initialize the
// workspace once per file rather than per test.  Each test still uses a
// unique PREFIX so rows don't bleed across test cases within the run.
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zana-ticket-svc-"));
  // .git boundary prevents resolveProjectDir from walking up to a shared /tmp/.zana
  fs.mkdirSync(path.join(tmpRoot, ".git"));
  wcDist.init(tmpRoot);
});

afterAll(() => {
  wcDist._resetForTesting();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// No-op: the SQLite backend is now workspace-scoped and the tmpRoot is
// deleted in afterAll.  Kept as a stub so beforeEach/afterEach calls compile.
function cleanupTestFiles(_prefix: string) {}

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

    it("auto-attaches a new ticket to the active sprint when sprintId is omitted", () => {
      const sprint = ticketService.createSprint({ name: `${PREFIX}-auto`, ticketIds: [] });
      ticketService.startSprint(sprint.id);

      const t = ticketService.createTicket({ title: `${PREFIX}-auto-tk`, createdBy: "test" });
      expect(t.sprintId).toBe(sprint.id);

      const board = ticketService.getSprintBoard(sprint.id);
      expect(board.backlog.some((bt: any) => bt.id === t.id)).toBe(true);

      ticketService.endSprint(sprint.id);
    });

    it("explicit sprintId still wins over auto-attach", () => {
      const active = ticketService.createSprint({ name: `${PREFIX}-active`, ticketIds: [] });
      ticketService.startSprint(active.id);
      const planning = ticketService.createSprint({ name: `${PREFIX}-planning`, ticketIds: [] });

      const t = ticketService.createTicket({ title: `${PREFIX}-pinned`, sprintId: planning.id, createdBy: "test" });
      expect(t.sprintId).toBe(planning.id);

      ticketService.endSprint(active.id);
    });

    it("leaves sprintId null when no sprint is active", () => {
      const t = ticketService.createTicket({ title: `${PREFIX}-orphan`, createdBy: "test" });
      expect(t.sprintId).toBeNull();
    });
  });
});
