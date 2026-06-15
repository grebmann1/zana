// Unit/integration test for the `ticket_update` routing branch in
// agents/dispatch.ts.
//
// Unlike `ticket_edit` (covered in dispatch-ticket-edit.test.ts), `ticket_update`
// does real filesystem work in the ticket's directory: it writes plan.md /
// result.md and — the non-trivial bit — MERGES params.filesChanged into an
// existing files-changed.json, de-duplicating across calls (dispatch.ts:244-249).
// That branch was previously unexercised.
//
// Strategy mirrors lifecycle-persist-run.test.ts: import via the compiled dist
// "@zana-ai/core" so the lazy require("../project/workspace-context") inside the
// branch resolves to its .js sibling (the Vite SSR runner can't resolve relative
// require() in raw .ts). The dist workspace-context singleton is init()-ed to a
// tmp dir, so the real ticket service is file-backed there. No network, no
// Claude, no real spawning — fully deterministic.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as core from "@zana-ai/core";

const workspaceContext: any = (core as any).project.workspaceContext;
const handle: (payload: any, getWorkspaceFn: any) => Promise<any> =
  (core as any).agents.manager.handleOrchestratorCommand;

const call = (action: string, params: Record<string, any> = {}) =>
  handle({ action, ...params }, null);

let tmpWs: string;
let ticketsDir: string;

beforeAll(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "zana-ticket-update-test-"));
  fs.mkdirSync(path.join(tmpWs, ".zana"), { recursive: true });
  workspaceContext.init(tmpWs);
  ticketsDir = workspaceContext.getProjectPaths().ticketsDir;
});

afterAll(() => {
  try { workspaceContext._resetForTesting?.(); } catch {}
  try { fs.rmSync(tmpWs, { recursive: true, force: true }); } catch {}
});

describe("handleOrchestratorCommand — ticket_update", () => {
  it("merges filesChanged across calls and de-duplicates the union", async () => {
    const created = await call("ticket_create", { title: "merge", description: "d" });
    const ticketId = created.id;

    await call("ticket_update", { ticketId, filesChanged: ["src/a.ts", "src/b.ts"] });
    // Second call repeats b.ts and adds c.ts — the result must be the deduped union.
    await call("ticket_update", { ticketId, filesChanged: ["src/b.ts", "src/c.ts"] });

    const fcPath = path.join(ticketsDir, ticketId, "files-changed.json");
    const stored = JSON.parse(fs.readFileSync(fcPath, "utf8"));

    expect(stored).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    // Guard against duplicates riding along.
    expect(new Set(stored).size).toBe(stored.length);
  });

  it("writes planification and result artifacts into the ticket directory", async () => {
    const created = await call("ticket_create", { title: "artifacts", description: "d" });
    const ticketId = created.id;

    await call("ticket_update", {
      ticketId,
      planification: "# Plan\nstep 1",
      resultSummary: "all done",
    });

    const dir = path.join(ticketsDir, ticketId);
    expect(fs.readFileSync(path.join(dir, "plan.md"), "utf8")).toContain("step 1");
    expect(fs.readFileSync(path.join(dir, "result.md"), "utf8")).toBe("all done");
  });

  it("returns a not-found error shape for an unknown ticket", async () => {
    const result = await call("ticket_update", { ticketId: "does-not-exist", progress: "x" });
    expect(result).toEqual({ error: "ticket not found" });
  });
});
