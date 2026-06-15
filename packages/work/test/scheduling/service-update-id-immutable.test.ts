// updateSchedule must NOT let a caller change a schedule's id via the fields
// payload. service.ts builds the updated record as:
//
//   const updated = { ...schedule, ...fields, id, updatedAt: ... };
//
// The trailing `id` (the original id argument) is spread LAST, so it always
// wins over any `fields.id`. This pins that invariant: a payload id is ignored,
// the schedule keeps its identity, and no phantom schedule is created under the
// injected id. A regression that reordered the spread (e.g. `{ id, ...fields }`)
// would let a caller rename / hijack a schedule — this test guards against it.
//
// Real workspace-context + real store (no mocks). The schedule is created
// disabled so updateSchedule never arms a live trigger — fully deterministic,
// no timers.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as workspaceContext from "@zana-ai/core/src/project/workspace-context.ts";
import * as core from "@zana-ai/core";
import * as schedulerService from "@zana-ai/work/src/scheduling/service.ts";

describe("updateSchedule — id is immutable via the fields payload", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zana-svc-updid-"));
    mkdirSync(join(tmpRoot, ".zana"), { recursive: true });
    workspaceContext.init(tmpRoot);
    try { (core as any).project.workspaceContext.init(tmpRoot); } catch {}
    schedulerService.stopAll();
  });

  afterEach(() => {
    schedulerService.stopAll();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("ignores a payload `id`, keeping the schedule's original identity", () => {
    const created: any = schedulerService.createSchedule({
      name: "original",
      every: "5m",
      action: { type: "command", command: ["echo", "x"] },
      enabled: false, // disabled → updateSchedule never arms a live trigger
    });
    const originalId = created.id as string;
    expect(originalId).toBeTruthy();

    const res: any = schedulerService.updateSchedule(originalId, {
      id: "evil-injected-id",
      name: "renamed",
    });

    // The update succeeds and the returned record keeps the ORIGINAL id.
    expect(res.ok).toBe(true);
    expect(res.schedule.id).toBe(originalId);
    expect(res.schedule.id).not.toBe("evil-injected-id");
    // Legitimate field edits still apply.
    expect(res.schedule.name).toBe("renamed");

    // The original schedule still exists under its real id...
    const reloaded: any = schedulerService.getSchedule(originalId);
    expect(reloaded).toBeTruthy();
    expect(reloaded.id).toBe(originalId);
    expect(reloaded.name).toBe("renamed");

    // ...and no phantom schedule was created under the injected id.
    const phantom = schedulerService.getSchedule("evil-injected-id");
    expect(phantom ?? null).toBeNull();
  });
});
