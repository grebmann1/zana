import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getLogger, _state } from "../../src/util/logger.ts";

// Capture stderr writes without touching real I/O
function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("getLogger / level filtering", () => {
  beforeEach(() => {
    delete process.env.ZANA_LOG_LEVEL;
    delete process.env.ZANA_LOG_FILE;
  });
  afterEach(() => {
    delete process.env.ZANA_LOG_LEVEL;
    delete process.env.ZANA_LOG_FILE;
  });

  it("defaults to info level", () => {
    expect(_state().level).toBe("info");
  });

  it("respects ZANA_LOG_LEVEL=debug", () => {
    process.env.ZANA_LOG_LEVEL = "debug";
    expect(_state().level).toBe("debug");
  });

  it("falls back to info for unrecognised ZANA_LOG_LEVEL", () => {
    process.env.ZANA_LOG_LEVEL = "verbose";
    expect(_state().level).toBe("info");
  });

  it("suppresses debug messages when level is info", () => {
    process.env.ZANA_LOG_LEVEL = "info";
    const { lines, restore } = captureStderr();
    const log = getLogger("test");
    log.debug("should not appear");
    restore();
    expect(lines).toHaveLength(0);
  });

  it("emits info messages when level is info", () => {
    process.env.ZANA_LOG_LEVEL = "info";
    const { lines, restore } = captureStderr();
    const log = getLogger("mymod");
    log.info("hello");
    restore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[info ]");
    expect(lines[0]).toContain("[mymod]");
    expect(lines[0]).toContain("hello");
  });

  it("emits warn and error when level is warn", () => {
    process.env.ZANA_LOG_LEVEL = "warn";
    const { lines, restore } = captureStderr();
    const log = getLogger("mod");
    log.info("suppressed");
    log.warn("visible-warn");
    log.error("visible-error");
    restore();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[warn ]");
    expect(lines[1]).toContain("[error]");
  });
});

describe("format — meta serialisation", () => {
  beforeEach(() => {
    process.env.ZANA_LOG_LEVEL = "debug";
    delete process.env.ZANA_LOG_FILE;
  });
  afterEach(() => {
    delete process.env.ZANA_LOG_LEVEL;
  });

  it("appends plain string meta", () => {
    const { lines, restore } = captureStderr();
    getLogger("m").info("msg", "extra");
    restore();
    expect(lines[0]).toContain("extra");
  });

  it("serialises object meta as JSON", () => {
    const { lines, restore } = captureStderr();
    getLogger("m").info("msg", { key: "val" });
    restore();
    expect(lines[0]).toContain('"key":"val"');
  });

  it("serialises Error meta using stack", () => {
    const { lines, restore } = captureStderr();
    const err = new Error("boom");
    getLogger("m").error("oops", err);
    restore();
    expect(lines[0]).toContain("boom");
  });

  it("serialises null meta as 'null'", () => {
    const { lines, restore } = captureStderr();
    getLogger("m").warn("msg", null);
    restore();
    expect(lines[0]).toContain("null");
  });

  it("includes ISO timestamp at start of line", () => {
    const { lines, restore } = captureStderr();
    getLogger("m").info("ts-test");
    restore();
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it("ends each line with a newline", () => {
    const { lines, restore } = captureStderr();
    getLogger("m").info("nl-test");
    restore();
    expect(lines[0]).toMatch(/\n$/);
  });
});
