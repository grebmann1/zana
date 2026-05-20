import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GUIDE_PATH = resolve(
  __dirname,
  "../../plugins/zana/core/skills/orchestration/GUIDE.md",
);

describe("orchestration GUIDE.md — Deliberation section", () => {
  const guide = readFileSync(GUIDE_PATH, "utf8");

  it("has a top-level ## Deliberation heading", () => {
    expect(guide).toMatch(/^## Deliberation\s*$/m);
  });

  it("mentions at least 3 of the state-machine phases", () => {
    const phases = [
      "REVIEWING",
      "SYNTHESIZING",
      "CONVERGING",
      "SETTLED",
      "ESCALATED",
    ];
    const present = phases.filter((p) => guide.includes(p));
    expect(present.length).toBeGreaterThanOrEqual(3);
  });

  it("contrasts Deliberation with Team and Autopilot", () => {
    expect(guide).toMatch(/Team/);
    expect(guide).toMatch(/Autopilot/);
    // contrast lives near the new section, not just in older prose
    const deliberationIndex = guide.indexOf("## Deliberation");
    const sliceAfter = guide.slice(deliberationIndex);
    expect(sliceAfter).toMatch(/Team/);
    expect(sliceAfter).toMatch(/Autopilot/);
  });

  it("documents both the slash command and the MCP tool", () => {
    expect(guide).toMatch(/\/zana:council/);
    expect(guide).toMatch(/zana_deliberate/);
  });
});
