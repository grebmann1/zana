// Regression tests for the launchd plist XML-escape security fix
// (ticket cede8470 — "SEC: Escape XML in launchd plist generation").
//
// Vulnerability: a workspace path containing `</string><string>...` could
// break out of the WorkingDirectory <string> element and inject extra
// ProgramArguments — persistent code execution as the user when
// `zana-daemon service install` runs.
//
// Fix: every value interpolated into a <string> body is run through
// escapeXml(), and buildMacosPlist() encapsulates the template so it can be
// unit-tested without invoking real `launchctl`.

import { describe, it, expect } from "vitest";

import * as svc from "@zana-ai/core/src/daemon/service-manager.ts";
const sm = svc as any;
const { escapeXml, buildMacosPlist } = sm.__test;

// Extract every <string>...</string> body in document order. Pure regex —
// adequate because we control the producer and its output is line-oriented.
function extractStrings(plist: string): string[] {
  const out: string[] = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plist)) !== null) out.push(m[1]);
  return out;
}

// Decode the five entities we emit, in reverse order of escape so &amp; comes
// last (mirroring escapeXml's order).
function decodeXml(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

describe("escapeXml() — entity replacement", () => {
  it("escapes & first so later replacements don't double-escape", () => {
    expect(escapeXml("&")).toBe("&amp;");
    expect(escapeXml("&lt;")).toBe("&amp;lt;"); // not &lt;
  });

  it("escapes <, >, \", '", () => {
    expect(escapeXml("<")).toBe("&lt;");
    expect(escapeXml(">")).toBe("&gt;");
    expect(escapeXml('"')).toBe("&quot;");
    expect(escapeXml("'")).toBe("&apos;");
  });

  it("escapes the launchd-plist breakout payload", () => {
    const evil = "</string><string>injected";
    expect(escapeXml(evil)).toBe("&lt;/string&gt;&lt;string&gt;injected");
  });

  it("is a no-op for ordinary path characters", () => {
    const safe = "/Users/alice/work/proj-1.2_final";
    expect(escapeXml(safe)).toBe(safe);
  });

  it("handles undefined-ish input by coercing to string", () => {
    expect(escapeXml(123 as unknown as string)).toBe("123");
  });
});

describe("buildMacosPlist() — XML-escape regression", () => {
  const baseOpts = {
    label: "com.zana.daemon",
    node: "/usr/local/bin/node",
    daemonBin: "/opt/zana/bin/daemon.js",
    workspace: "/Users/alice/work",
    port: "47400",
    logPath: "/Users/alice/.zana/logs/daemon.log",
  };

  it("produces a well-formed plist on benign input", () => {
    const plist = buildMacosPlist(baseOpts);
    expect(plist).toContain("<?xml version=");
    expect(plist).toContain("<plist version=\"1.0\">");
    expect(plist).toMatch(/<\/plist>\s*$/);

    const strings = extractStrings(plist);
    // Label, node, daemonBin, --workspace, workspace, --port, port, log, log, workspace
    expect(strings).toEqual([
      "com.zana.daemon",
      "/usr/local/bin/node",
      "/opt/zana/bin/daemon.js",
      "--workspace",
      "/Users/alice/work",
      "--port",
      "47400",
      "/Users/alice/.zana/logs/daemon.log",
      "/Users/alice/.zana/logs/daemon.log",
      "/Users/alice/work",
    ]);
  });

  it("does NOT inject extra ProgramArguments when workspace contains breakout payload", () => {
    const evilWorkspace =
      "/tmp/evil</string><string>/Applications/Calculator.app/Contents/MacOS/Calculator";
    const plist = buildMacosPlist({ ...baseOpts, workspace: evilWorkspace });

    const strings = extractStrings(plist);
    // Same exact count and ordering as the benign case — no injection.
    expect(strings).toHaveLength(10);

    // ProgramArguments array (indices 1..6 inclusive) keeps its 6-element shape:
    // node, daemonBin, "--workspace", <workspace>, "--port", <port>.
    expect(strings[3]).toBe("--workspace");
    expect(strings[5]).toBe("--port");
    expect(strings[6]).toBe("47400");

    // Decoded WorkingDirectory contains the *literal* malicious string —
    // no string was lost or split off into a separate element.
    expect(decodeXml(strings[4])).toBe(evilWorkspace);
    expect(decodeXml(strings[9])).toBe(evilWorkspace);

    // The raw <string> body must not contain unescaped angle brackets in the
    // workspace slot — that's the actual exploit signature.
    expect(strings[4]).not.toContain("</string>");
    expect(strings[4]).not.toContain("<string>");
    expect(strings[4]).toContain("&lt;/string&gt;&lt;string&gt;");
  });

  it("escapes ampersands in label without breaking subsequent entities", () => {
    const plist = buildMacosPlist({ ...baseOpts, label: "a&b<c>d\"e'f" });
    const strings = extractStrings(plist);
    expect(strings[0]).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
    expect(decodeXml(strings[0])).toBe("a&b<c>d\"e'f");
  });

  it("escapes the CDATA-end sentinel ]]> in workspace path", () => {
    // ]]> doesn't currently break our template (we don't use CDATA), but
    // escaping > defangs it just in case future maintainers wrap a value in
    // <![CDATA[...]]>.
    const plist = buildMacosPlist({ ...baseOpts, workspace: "/tmp/]]>evil" });
    const strings = extractStrings(plist);
    expect(strings[4]).toBe("/tmp/]]&gt;evil");
    expect(decodeXml(strings[4])).toBe("/tmp/]]>evil");
  });

  it("round-trips: every <string> body decodes back to the original input", () => {
    const opts = {
      label: "label & co",
      node: '/n"o<de>',
      daemonBin: "/d'aemon&bin",
      workspace: "</string><string>x",
      port: "47400",
      logPath: "/log/path<>&\"'",
    };
    const plist = buildMacosPlist(opts);
    const strings = extractStrings(plist);

    // strings[0]=label, [1]=node, [2]=daemonBin, [3]="--workspace",
    // [4]=workspace, [5]="--port", [6]=port, [7]=logPath, [8]=logPath,
    // [9]=workspace
    expect(decodeXml(strings[0])).toBe(opts.label);
    expect(decodeXml(strings[1])).toBe(opts.node);
    expect(decodeXml(strings[2])).toBe(opts.daemonBin);
    expect(decodeXml(strings[4])).toBe(opts.workspace);
    expect(decodeXml(strings[7])).toBe(opts.logPath);
    expect(decodeXml(strings[8])).toBe(opts.logPath);
    expect(decodeXml(strings[9])).toBe(opts.workspace);
  });
});
