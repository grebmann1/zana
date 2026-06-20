// listRuns() applies the `status` filter BEFORE slicing for limit/offset
// (store.ts lines 61-66). store.test.ts pins status-filtering and
// limit/offset pagination INDEPENDENTLY, but never together — so a regression
// that paginated the full mixed set first and only then filtered by status
// would return short, wrong pages yet pass every existing test.
//
// The fixture interleaves running runs among completed ones so the newest two
// records overall are NOT both completed. Correct (filter-first) behaviour
// returns a FULL page of completed runs; the buggy (paginate-first) order
// would leak running runs into the window and drop the page below `limit`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as workspaceContext from "@zana-ai/contracts";
import * as core from "@zana-ai/core";
import { listRuns, saveRun } from "@zana-ai/work/src/runs/store.ts";

const TEST_WORKSPACE = path.join(
  os.tmpdir(),
  `zana-test-runs-store-filter-page-${Date.now()}-${process.pid}`
);

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    daemonId: "default",
    workspace: TEST_WORKSPACE,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    agents: [],
    subDaemons: [],
    ...overrides,
  };
}

describe("runs/store — listRuns filters by status before paginating", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(TEST_WORKSPACE, ".zana"), { recursive: true });
    workspaceContext.init(TEST_WORKSPACE);
    try { (core as any).project.workspaceContext.init(TEST_WORKSPACE); } catch {}
  });

  afterEach(() => {
    try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
  });

  it("returns a full page of only the matching status, even when newer non-matching runs exist", () => {
    // Newest-first by startedAt: r5(running) > r4(completed) > r3(running)
    //                           > r2(completed) > r1(completed)
    saveRun(makeRun({ id: "r1", status: "completed", startedAt: 1000 }));
    saveRun(makeRun({ id: "r2", status: "completed", startedAt: 2000 }));
    saveRun(makeRun({ id: "r3", status: "running", startedAt: 3000 }));
    saveRun(makeRun({ id: "r4", status: "completed", startedAt: 4000 }));
    saveRun(makeRun({ id: "r5", status: "running", startedAt: 5000 }));

    const page1 = listRuns({ status: "completed", limit: 2, offset: 0 });

    // Filter-first: the two newest COMPLETED runs (r4, then r2).
    // Paginate-first would slice [r5, r4] then filter → only [r4], length 1.
    expect(page1.map((r) => r.id)).toEqual(["r4", "r2"]);
    expect(page1).toHaveLength(2);
    expect(page1.every((r) => r.status === "completed")).toBe(true);
  });

  it("offset is applied to the filtered set, not the raw set", () => {
    saveRun(makeRun({ id: "r1", status: "completed", startedAt: 1000 }));
    saveRun(makeRun({ id: "r2", status: "completed", startedAt: 2000 }));
    saveRun(makeRun({ id: "r3", status: "running", startedAt: 3000 }));
    saveRun(makeRun({ id: "r4", status: "completed", startedAt: 4000 }));
    saveRun(makeRun({ id: "r5", status: "running", startedAt: 5000 }));

    // Completed, newest-first: [r4, r2, r1]; offset 2 → the third one only.
    const page2 = listRuns({ status: "completed", limit: 2, offset: 2 });
    expect(page2.map((r) => r.id)).toEqual(["r1"]);
  });
});
