// Additional noSecrets() coverage for patterns not exercised in builtins.test.ts:
//   • Slack tokens  — xox[bpras]-<alphanumeric-dash>
//   • GitHub OAuth tokens — gho_<36+ chars>
//   • containsPattern default name (no description arg)
//
// All guards are pure value-in / {pass, feedback} out — no I/O, no network.

import { describe, it, expect } from "vitest";
import { noSecrets, containsPattern } from "../../src/guardrails/builtins.ts";

// ---------------------------------------------------------------------------
// noSecrets — Slack token patterns
// ---------------------------------------------------------------------------
describe("noSecrets — Slack tokens", () => {
  const guard = noSecrets();

  it("fails when output contains a Slack bot token (xoxb-)", () => {
    const r = guard.validate("token=xoxb-abc123def456-ghi789");
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/secrets/i);
  });

  it("fails when output contains a Slack user token (xoxp-)", () => {
    const r = guard.validate("my token: xoxp-123456789012-987654321098-foo");
    expect(r.pass).toBe(false);
  });

  it("fails when output contains a Slack refresh token (xoxr-)", () => {
    const r = guard.validate("xoxr-refreshtoken-value");
    expect(r.pass).toBe(false);
  });

  it("fails when output contains a Slack app token (xoxa-)", () => {
    const r = guard.validate("use xoxa-my-app-token-here");
    expect(r.pass).toBe(false);
  });

  it("fails when output contains a Slack service token (xoxs-)", () => {
    const r = guard.validate("stored: xoxs-service-token-123");
    expect(r.pass).toBe(false);
  });

  it("passes on text that contains 'xox' but is not a valid Slack token prefix", () => {
    // Must start with xox[bpras] followed by '-'; bare 'xox' or other letters don't match.
    const r = guard.validate("The proxy rocks (xoxymora is a word)");
    expect(r.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// noSecrets — GitHub OAuth tokens (gho_)
// ---------------------------------------------------------------------------
describe("noSecrets — GitHub OAuth tokens (gho_)", () => {
  const guard = noSecrets();

  it("fails when output contains a GitHub OAuth token (gho_)", () => {
    // gho_ tokens are 40+ chars; the pattern requires at least 36 alphanum after the prefix.
    const r = guard.validate("oauth=gho_" + "a".repeat(36));
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/secrets/i);
  });

  it("passes on clean text that incidentally contains 'gho' but not gho_ pattern", () => {
    const r = guard.validate("The Ghosts of Gondor (gho for short)");
    expect(r.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// noSecrets — sk- pattern false-positive avoidance
//
// The sk- rule is /(?:^|[^a-zA-Z0-9])(sk-[a-zA-Z0-9]{20,})/ — two guards the
// existing suite never exercises on this prefix:
//   1. a {20,} length floor, so short "sk-" fragments are NOT treated as keys
//   2. a (?:^|[^a-zA-Z0-9]) left boundary, so an "sk-" that is glued to a
//      preceding alphanumeric char (i.e. mid-word, like "disk-") does NOT match
// Both protect against noisy false positives that would block legitimate
// output. They are pure value-in / {pass} out — no I/O.
// ---------------------------------------------------------------------------
describe("noSecrets — sk- false-positive avoidance", () => {
  const guard = noSecrets();

  it("passes when an sk- fragment is shorter than the 20-char minimum", () => {
    // "sk-short" has only 5 chars after the prefix — below the {20,} floor.
    const r = guard.validate("the disk-usage sk-short label");
    expect(r.pass).toBe(true);
  });

  it("passes when a 20+ char sk- run is glued to a preceding alphanumeric char", () => {
    // 'sk-' here is preceded by 'i' (from "disk-"), so neither ^ nor the
    // [^a-zA-Z0-9] boundary alternative matches — must not be flagged.
    const r = guard.validate("disk-" + "a".repeat(20));
    expect(r.pass).toBe(true);
  });

  it("still fails a real sk- key once the boundary and length both hold", () => {
    // Sanity anchor: a properly bounded, full-length key is still caught,
    // so the two passes above are about boundaries — not a dead guard.
    const r = guard.validate("token is sk-" + "a".repeat(20));
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/secrets/i);
  });
});

// ---------------------------------------------------------------------------
// containsPattern — default name when no description is provided
// ---------------------------------------------------------------------------
describe("containsPattern — default name", () => {
  it("uses Matches: <pattern.source> as the guard name when description is omitted", () => {
    const guard = containsPattern(/DONE/);
    expect(guard.name).toBe("Matches: DONE");
  });

  it("uses the explicit description as name when provided", () => {
    const guard = containsPattern(/DONE/, "output must say DONE");
    expect(guard.name).toBe("output must say DONE");
  });

  it("uses pattern.source as name when a string pattern is passed with no description", () => {
    const guard = containsPattern("READY");
    // String is converted to RegExp; name should be the source string.
    expect(guard.name).toContain("READY");
  });
});
