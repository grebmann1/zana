// logger.ts routes output to a file when ZANA_LOG_FILE is set (getFileStream()
// + the `if (stream)` branch of emit()). The sibling logger.test.ts always
// DELETES ZANA_LOG_FILE, so the entire file-sink path is untested. We vi.mock
// node:fs (the repo's established fs-mock pattern, mirroring
// host/detect-fs-fallback.test.ts) with a synchronous fake stream so writes are
// observable without the real WriteStream's async flush — fully deterministic,
// no real filesystem.
//
// The logger caches its WriteStream at module scope keyed by path, and this
// module is imported once for the whole file. Each test therefore uses a UNIQUE
// path so getFileStream() is forced to (re)create the stream and hand back the
// current test's fake rather than a stale one cached by a previous test.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";

// Mutable slots the mock factory consults on every call.
let writes: string[] = [];
let createCount = 0;
let lastMkdirPath: string | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (p: any) => { lastMkdirPath = String(p); return undefined; },
    createWriteStream: () => {
      createCount += 1;
      return { write: (c: any) => { writes.push(String(c)); return true; }, end: () => {} } as any;
    },
  };
});

// Import after vi.mock so production code binds the mocked fs.
import { getLogger, _state } from "@zana-ai/core/src/util/logger.ts";

describe("logger — ZANA_LOG_FILE sink", () => {
  let counter = 0;
  let logPath: string;
  let parentDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    counter += 1;
    parentDir = `/tmp/zana-logger-sink-test-${counter}`;
    logPath = path.join(parentDir, "app.log");
    writes = [];
    createCount = 0;
    lastMkdirPath = null;
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.ZANA_LOG_LEVEL = "info";
    process.env.ZANA_LOG_FILE = logPath;
  });

  afterEach(() => {
    delete process.env.ZANA_LOG_FILE;
    delete process.env.ZANA_LOG_LEVEL;
    vi.restoreAllMocks();
  });

  it("_state() reports the configured file path", () => {
    expect(_state().file).toBe(logPath);
  });

  it("routes log output to the file stream, not stderr", () => {
    getLogger("sink").info("to-file");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("[sink]");
    expect(writes[0]).toContain("to-file");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("creates the log file's parent directory", () => {
    getLogger("sink").info("mkdir-check");
    expect(lastMkdirPath).toBe(parentDir);
  });

  it("reuses one stream for the same path across calls", () => {
    const log = getLogger("sink");
    log.info("first");
    log.info("second");
    expect(writes).toHaveLength(2);
    expect(createCount).toBe(1); // cached, not recreated per emit
  });
});
