// Tests for packages/work/src/teams/store.ts — saveTeam slot normalization.
// The slot filter keeps only slots with a truthy profileId AND a NUMERIC
// quantity >= 1 (`typeof s.quantity === "number"`). Existing tests cover the
// falsy-profileId and quantity-below-1 cases; this pins the distinct
// non-numeric/missing-quantity branch, which existing tests do not exercise.
// @zana-ai/core is mocked to an isolated temp dir — no global ~/.zana writes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

const { TEAMS_DIR } = vi.hoisted(() => {
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  return {
    TEAMS_DIR: nodePath.join(
      nodeOs.tmpdir(),
      `zana-test-teams-store-qty-${Date.now()}-${process.pid}`
    ),
  };
});

vi.mock("@zana-ai/core", () => ({
  config: { TEAMS_DIR },
}));

import { saveTeam } from "@zana-ai/work/src/teams/store.ts";

describe("teams/store — saveTeam non-numeric quantity filter", () => {
  beforeEach(() => fs.mkdirSync(TEAMS_DIR, { recursive: true }));
  afterEach(() => { try { fs.rmSync(TEAMS_DIR, { recursive: true, force: true }); } catch {} });

  it("drops slots whose quantity is a string, and missing quantity, while keeping numeric slots", () => {
    const team = saveTeam({
      id: "qty-filter-team",
      name: "Quantity Filter",
      slots: [
        { profileId: "stringy", quantity: "3" } as any, // typeof !== "number" → dropped
        { profileId: "noqty" } as any,                   // quantity undefined → dropped
        { profileId: "keeper", quantity: 2 },            // valid → survives
      ],
    });

    expect(team.slots).toHaveLength(1);
    expect(team.slots[0]).toEqual({ profileId: "keeper", quantity: 2 });
    // workerProfileIds is derived from the surviving slots only.
    expect(team.workerProfileIds).toEqual(["keeper"]);
  });
});
