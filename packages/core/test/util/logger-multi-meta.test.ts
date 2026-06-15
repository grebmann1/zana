import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getLogger } from "../../src/util/logger.ts";

// Capture stderr writes without touching real I/O.
function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

// logger.ts serialises the meta tail with `meta.map(...).join(" ")`. The
// existing suite only ever passes a SINGLE meta argument, so the join logic
// (separator + per-element serialisation across mixed types in one call) is
// never exercised. This pins that multiple meta args are appended in order,
// each serialised by its own rule (string / JSON object / null), and joined
// by exactly one space — guarding against a regression in the separator or
// element ordering.
describe("logger — multiple meta arguments", () => {
  beforeEach(() => {
    process.env.ZANA_LOG_LEVEL = "debug";
    delete process.env.ZANA_LOG_FILE;
  });
  afterEach(() => {
    delete process.env.ZANA_LOG_LEVEL;
    delete process.env.ZANA_LOG_FILE;
  });

  it("joins mixed meta args in order, separated by a single space", () => {
    const { lines, restore } = captureStderr();
    getLogger("m").info("msg", "alpha", { k: 1 }, null);
    restore();

    expect(lines).toHaveLength(1);
    // msg, then the three meta elements, each by its own serialisation rule,
    // joined by exactly one space.
    expect(lines[0]).toContain('msg alpha {"k":1} null\n');
  });
});
