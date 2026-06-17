// Structural / launchd-policy contract for buildMacosPlist().
//
// The sibling service-manager-xml-escape.test.ts exhaustively pins the
// <string> BODIES of the generated plist (escaping + ProgramArguments shape).
// It never inspects the <key> structure or the launchd policy booleans, so a
// regression that flips RunAtLoad / KeepAlive from <true/> to <false/> — or
// drops a required key entirely — would silently make the daemon stop
// auto-starting at login or stop being restarted on crash, yet pass every
// existing test (they only read <string> contents).
//
// These tests are pure: buildMacosPlist() takes plain options and returns a
// string. No fs, no launchctl, no timers — fully deterministic.

import { describe, it, expect } from "vitest";

import * as svc from "@zana-ai/core/src/daemon/service-manager.ts";
const { buildMacosPlist } = (svc as any).__test;

const baseOpts = {
  label: "com.zana.daemon",
  node: "/usr/local/bin/node",
  daemonBin: "/opt/zana/bin/daemon.js",
  workspace: "/Users/alice/work",
  port: "47400",
  logPath: "/Users/alice/.zana/logs/daemon.log",
};

describe("buildMacosPlist() — launchd policy structure", () => {
  it("declares RunAtLoad and KeepAlive as <true/> so the daemon auto-starts and is kept alive", () => {
    const plist = buildMacosPlist(baseOpts);

    // The boolean immediately following each policy key must be <true/>.
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);

    // And neither policy may be emitted as <false/> anywhere.
    expect(plist).not.toContain("<false/>");
  });

  it("emits every required launchd key exactly once and in document order", () => {
    const plist = buildMacosPlist(baseOpts);

    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual([
      "Label",
      "ProgramArguments",
      "RunAtLoad",
      "KeepAlive",
      "StandardOutPath",
      "StandardErrorPath",
      "WorkingDirectory",
    ]);
  });
});
