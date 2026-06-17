/**
 * Tiny structured logger. Replaces ad-hoc console.* calls scattered across
 * core/work/server. Single-line output to stderr by default; an optional
 * file sink can be attached via ZANA_LOG_FILE.
 *
 * Why not pino/winston? Our log volume is small and we don't need
 * high-performance JSON streaming. A 60-line wrapper with a level filter
 * is enough; we can swap later if real-world volume changes.
 *
 * Format:
 *   2026-05-19T01:23:45.678Z [info ] [scheduler] message  meta-as-json
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Level = "debug" | "info" | "warn" | "error";

const LEVEL_VALUE: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): Level {
  const raw = (process.env.ZANA_LOG_LEVEL || "").toLowerCase().trim();
  if (raw && raw in LEVEL_VALUE) return raw as Level;
  return "info";
}

let fileStream: fs.WriteStream | null = null;
let fileStreamPath: string | null = null;

function getFileStream(): fs.WriteStream | null {
  const target = process.env.ZANA_LOG_FILE;
  if (!target) {
    if (fileStream) {
      try { fileStream.end(); } catch {}
      fileStream = null;
      fileStreamPath = null;
    }
    return null;
  }
  if (fileStream && fileStreamPath === target) return fileStream;
  if (fileStream) {
    try { fileStream.end(); } catch {}
    fileStream = null;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fileStream = fs.createWriteStream(target, { flags: "a" });
    fileStreamPath = target;
    return fileStream;
  } catch {
    return null;
  }
}

function format(level: Level, mod: string, msg: string, meta: any[]): string {
  const ts = new Date().toISOString();
  const padded = level.padEnd(5);
  let line = `${ts} [${padded}] [${mod}] ${msg}`;
  if (meta.length) {
    const tail = meta.map((m) => {
      if (m == null) return String(m);
      if (m instanceof Error) {
        return m.stack || `${m.name}: ${m.message}`;
      }
      if (typeof m === "object") {
        try { return JSON.stringify(m); } catch { return String(m); }
      }
      return String(m);
    }).join(" ");
    line += ` ${tail}`;
  }
  return line + "\n";
}

function emit(level: Level, mod: string, msg: string, meta: any[]) {
  if (LEVEL_VALUE[level] < LEVEL_VALUE[resolveLevel()]) return;
  const line = format(level, mod, msg, meta);
  const stream = getFileStream();
  if (stream) {
    try { stream.write(line); } catch {}
  } else {
    process.stderr.write(line);
  }
}

export interface Logger {
  debug(msg: string, ...meta: any[]): void;
  info(msg: string, ...meta: any[]): void;
  warn(msg: string, ...meta: any[]): void;
  error(msg: string, ...meta: any[]): void;
}

export function getLogger(mod: string): Logger {
  return {
    debug: (msg, ...meta) => emit("debug", mod, msg, meta),
    info: (msg, ...meta) => emit("info", mod, msg, meta),
    warn: (msg, ...meta) => emit("warn", mod, msg, meta),
    error: (msg, ...meta) => emit("error", mod, msg, meta),
  };
}

/** Test-only: snapshot resolved level + sink. */
export function _state() {
  return { level: resolveLevel(), file: process.env.ZANA_LOG_FILE || null };
}
