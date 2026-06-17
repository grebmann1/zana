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
// noSecrets — GitHub PAT (ghp_) false-positive avoidance
//
// The ghp_ rule is /(?:^|[^a-zA-Z0-9])(ghp_[a-zA-Z0-9]{36,})/. builtins.test.ts
// pins only the POSITIVE case (a full 36-char ghp_ token is flagged), and the
// sibling gho_ block here pins only an incidental-prose negative. The two guards
// that keep the ghp_ rule from over-firing are otherwise unexercised — exactly
// the false-positive surface the sk-/AKIA blocks below pin for their prefixes:
//   1. a {36,} length floor, so a short "ghp_" fragment is NOT treated as a key
//   2. a (?:^|[^a-zA-Z0-9]) left boundary, so a ghp_ run glued to a preceding
//      alphanumeric char (mid-token) does NOT match
// A regression touching just the ghp_ length/boundary would slip past every
// other secret test. Pure value-in / {pass} out — no I/O.
// ---------------------------------------------------------------------------
describe("noSecrets — ghp_ (GitHub PAT) false-positive avoidance", () => {
  const guard = noSecrets();

  it("passes when a ghp_ run is shorter than the 36-char minimum", () => {
    // 35 chars after the prefix — below the {36,} floor.
    const r = guard.validate("token=ghp_" + "a".repeat(35));
    expect(r.pass).toBe(true);
  });

  it("passes when a full-length ghp_ run is glued to a preceding alphanumeric char", () => {
    // 'x' immediately precedes ghp_, so neither ^ nor the [^a-zA-Z0-9] boundary
    // alternative matches — must not be flagged despite the 36-char body.
    const r = guard.validate("prefixghp_" + "a".repeat(36));
    expect(r.pass).toBe(true);
  });

  it("still fails a properly bounded, full-length ghp_ token", () => {
    // Sanity anchor: the length/boundary guards above are about false positives,
    // not a dead rule — a real, bounded PAT is still caught.
    const r = guard.validate("token is ghp_" + "a".repeat(36));
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/secrets/i);
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
// noSecrets — AWS access-key id (AKIA) false-positive avoidance
//
// The AWS rule is /(?:^|[^a-zA-Z0-9])(AKIA[0-9A-Z]{16})/. builtins.test.ts pins
// only the POSITIVE case (a bounded "AKIA…EXAMPLE" is flagged); the three
// guards that keep it from over-firing are otherwise unexercised on this prefix
// and a regression touching just the AKIA pattern would slip past every other
// secret test:
//   1. a (?:^|[^a-zA-Z0-9]) left boundary, so an AKIA run glued to a preceding
//      alphanumeric char (mid-token, e.g. inside a hash) does NOT match
//   2. an exactly-{16} body of [0-9A-Z], so a shorter run is NOT a key
//   3. an UPPERCASE-only [0-9A-Z] body, so a lowercased look-alike does NOT match
// All pure value-in / {pass} out — no I/O. The verified behavior: a bounded
// 16-char uppercase run is flagged; the three variants below are not.
// ---------------------------------------------------------------------------
describe("noSecrets — AKIA (AWS access key) false-positive avoidance", () => {
  const guard = noSecrets();
  const body = "IOSFODNN7EXAMPL1"; // exactly 16 chars of [0-9A-Z]

  it("passes when an AKIA run is glued to a preceding alphanumeric char", () => {
    // 'x' immediately precedes AKIA, so neither ^ nor the [^a-zA-Z0-9] boundary
    // alternative matches — must not be flagged.
    const r = guard.validate("hashx" + "AKIA" + body);
    expect(r.pass).toBe(true);
  });

  it("passes when the AKIA body is shorter than the required 16 chars", () => {
    // 15 chars after the prefix — below the {16} floor.
    const r = guard.validate("key AKIA" + "IOSFODNN7EXAMP1");
    expect(r.pass).toBe(true);
  });

  it("passes when the AKIA body contains lowercase (charset is [0-9A-Z] only)", () => {
    const r = guard.validate("key AKIA" + body.toLowerCase());
    expect(r.pass).toBe(true);
  });

  it("still fails a properly bounded, full-length uppercase AKIA key", () => {
    // Sanity anchor: the boundary/length/charset guards above are about false
    // positives, not a dead rule — a real key is still caught.
    const r = guard.validate("creds: AKIA" + body);
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/secrets/i);
  });
});

// ---------------------------------------------------------------------------
// noSecrets — PEM private-key header, optional algorithm prefix
//
// The SECRET_PATTERNS entry is /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/.
// builtins.test.ts only exercises the "RSA " variant, so the OPTIONAL nature of
// that prefix is unpinned: a regression that drops the `?` (making an algorithm
// label mandatory) would still pass the RSA test while silently letting a bare
// PKCS#8 "-----BEGIN PRIVATE KEY-----" header — the most common modern form —
// leak through undetected. These pin every accepted variant plus the prefixless
// case, with a negative control that a non-PEM "PRIVATE KEY" phrase is allowed.
// ---------------------------------------------------------------------------
describe("noSecrets — PEM private-key header variants", () => {
  const guard = noSecrets();

  it.each([
    ["bare PKCS#8 (no algorithm prefix)", "-----BEGIN PRIVATE KEY-----\nMIIE..."],
    ["RSA", "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."],
    ["EC", "-----BEGIN EC PRIVATE KEY-----\nMHcC..."],
    ["DSA", "-----BEGIN DSA PRIVATE KEY-----\nMIIB..."],
  ])("fails on a %s PEM private-key header", (_label, output) => {
    const r = guard.validate(output);
    expect(r.pass).toBe(false);
    expect((r as any).feedback).toMatch(/secrets/i);
  });

  it("passes when 'PRIVATE KEY' appears without the PEM BEGIN header", () => {
    // The pattern anchors on the full "-----BEGIN ... PRIVATE KEY-----" header,
    // so prose mentioning a private key is not a false positive.
    const r = guard.validate("Store your PRIVATE KEY in a secrets manager.");
    expect(r.pass).toBe(true);
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
