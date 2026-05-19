// Smoke tests for packages/core/src/util/logger.ts.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("util/logger", () => {
  afterEach(() => {
    delete process.env.ZANA_LOG_LEVEL;
    delete process.env.ZANA_LOG_FILE;
  });

  it("emits to stderr in default config", async () => {
    const { getLogger } = await import("@zana/core/src/util/logger.ts");
    const log = getLogger("smoke");
    const written: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (s: any) => { written.push(String(s)); return true; };
    try {
      log.info("hello", { k: 1 });
      log.warn("watch out");
    } finally {
      (process.stderr.write as any) = origWrite;
    }
    const joined = written.join("");
    expect(joined).toMatch(/\[info \] \[smoke\] hello \{"k":1\}/);
    expect(joined).toMatch(/\[warn \] \[smoke\] watch out/);
  });

  it("respects ZANA_LOG_LEVEL=warn (filters info/debug)", async () => {
    process.env.ZANA_LOG_LEVEL = "warn";
    const { getLogger, _state } = await import("@zana/core/src/util/logger.ts");
    expect(_state().level).toBe("warn");
    const log = getLogger("flt");
    const written: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (s: any) => { written.push(String(s)); return true; };
    try {
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    } finally {
      (process.stderr.write as any) = origWrite;
    }
    const joined = written.join("");
    expect(joined).not.toMatch(/\[info \]/);
    expect(joined).not.toMatch(/\[debug\]/);
    expect(joined).toMatch(/\[warn \]/);
    expect(joined).toMatch(/\[error\]/);
  });

  it("writes to ZANA_LOG_FILE when set", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "log-"));
    const target = join(tmp, "z.log");
    process.env.ZANA_LOG_FILE = target;
    const { getLogger } = await import("@zana/core/src/util/logger.ts");
    const log = getLogger("file");
    log.info("written to disk", { ok: true });
    // wait a tick for the write stream to flush
    await new Promise((r) => setTimeout(r, 50));
    const txt = readFileSync(target, "utf8");
    expect(txt).toMatch(/\[info \] \[file\] written to disk/);
    rmSync(tmp, { recursive: true, force: true });
  });
});
