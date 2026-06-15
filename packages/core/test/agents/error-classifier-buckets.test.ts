// Unit tests for classifySpawnError's bucket-matching surface. The sibling
// error-classifier.test.ts covers the 529/overload retry gate; this file
// covers the auth/quota/transport buckets, the documented "auth before
// transport" ordering invariant, and how non-string error shapes (objects with
// code/message, null/undefined) are coerced before matching.

import { describe, it, expect } from "vitest";
import { classifySpawnError } from "@zana-ai/core/src/agents/error-classifier.ts";

describe("classifySpawnError — auth bucket", () => {
  it("buckets 401/403 and auth phrasing as auth", () => {
    expect(classifySpawnError("HTTP 401 Unauthorized")).toBe("auth");
    expect(classifySpawnError("403 Forbidden")).toBe("auth");
    expect(classifySpawnError("invalid-token supplied")).toBe("auth");
  });
});

describe("classifySpawnError — quota bucket", () => {
  it("buckets payment/quota/usage-limit phrasing as quota", () => {
    expect(classifySpawnError("402 Payment Required")).toBe("quota");
    expect(classifySpawnError("monthly quota exhausted")).toBe("quota");
    expect(classifySpawnError("usage limit reached")).toBe("quota");
  });
});

describe("classifySpawnError — transport bucket", () => {
  it("buckets network/DNS/TLS error codes as transport", () => {
    expect(classifySpawnError("getaddrinfo ENOTFOUND api.host")).toBe("transport");
    expect(classifySpawnError("connect ECONNREFUSED 127.0.0.1:443")).toBe("transport");
    expect(classifySpawnError("socket hang up ECONNRESET")).toBe("transport");
  });
});

describe("classifySpawnError — ordering invariant", () => {
  // Documented in the source: auth is matched before transport so a gateway
  // that rejects creds over TLS buckets as auth, not transport.
  it("prefers auth over transport when a message mentions both TLS and 401", () => {
    expect(classifySpawnError("TLS 401 cert error")).toBe("auth");
  });

  // classifySpawnError checks buckets top-to-bottom (auth → rate_limit → quota
  // → transport) and returns on the first match, so when a message matches
  // MULTIPLE patterns the earliest-checked bucket wins. The sibling auth-over-
  // transport case pins only one edge of that order; these pin the rest. The
  // 429-over-quota edge is cost-critical: a "429 ... quota" blip must bucket as
  // rate_limit (retryable backpressure), never as the structural quota bucket
  // (which would suppress the retry and surface a false "out of quota").
  it("resolves to the earliest-checked bucket when a message matches several patterns", () => {
    // auth (401) is checked before rate_limit (429)
    expect(classifySpawnError("401 Unauthorized — also 429")).toBe("auth");
    // rate_limit (429) is checked before quota
    expect(classifySpawnError("429 too many requests; monthly quota nearly exhausted"))
      .toBe("rate_limit");
    // quota (402) is checked before transport (ECONNRESET)
    expect(classifySpawnError("402 Payment Required after ECONNRESET")).toBe("quota");
  });
});

describe("classifySpawnError — non-string error shapes", () => {
  it("returns 'spawn' for null, undefined, and empty string", () => {
    expect(classifySpawnError(null)).toBe("spawn");
    expect(classifySpawnError(undefined)).toBe("spawn");
    expect(classifySpawnError("")).toBe("spawn");
  });

  it("joins an error object's code and message before matching", () => {
    expect(classifySpawnError({ code: "ECONNREFUSED", message: "down" })).toBe("transport");
    expect(classifySpawnError({ message: "429 too many requests" })).toBe("rate_limit");
  });

  it("matches on code alone when message is absent", () => {
    expect(classifySpawnError({ code: "ETIMEDOUT" })).toBe("transport");
  });

  // errToString (error-classifier.ts) only collects `code`/`message` when they
  // are STRINGS; for an object carrying neither it falls back to String(err),
  // i.e. the object's own toString(). The sibling tests always supply a string
  // code or message, so this `parts.length === 0` fallback branch is otherwise
  // unpinned — a regression dropping it (and thus mis-coercing such objects)
  // would still pass every other case. A custom toString carrying a recognized
  // token must still bucket correctly.
  it("coerces an object with no string code/message via String(err)/toString", () => {
    const errLike = { toString: () => "boom ECONNREFUSED happened" };
    expect(classifySpawnError(errLike)).toBe("transport");
  });

  it("returns 'spawn' for a plain object whose String() coercion matches nothing", () => {
    // String({}) === "[object Object]" — no bucket token → legacy 'spawn'.
    expect(classifySpawnError({ unrelated: 1 })).toBe("spawn");
  });

  // errToString (error-classifier.ts) only collects `code`/`message` when they
  // are STRINGS (`typeof === "string"`). A NUMERIC status code is therefore
  // dropped, not matched: an object carrying only `{ code: 429 }` coerces via
  // String(err) → "[object Object]" and falls through to the legacy 'spawn'
  // bucket — it is NOT bucketed as rate_limit. Even when a non-matching string
  // message accompanies a numeric code (`{ code: 401, message: "boom" }`), the
  // numeric code cannot leak through to flip the bucket. This pins the contract
  // that callers must stringify HTTP status codes into the message/code STRING
  // for the heuristics to see them; the sibling object-shape tests only ever
  // supply string fields, so this numeric-drop edge is otherwise unpinned and a
  // regression honoring numeric codes would silently change retry behavior.
  it("drops a numeric `code` — only string code/message are matched", () => {
    // 429 as a number is ignored → no rate_limit, falls through to 'spawn'.
    expect(classifySpawnError({ code: 429 })).toBe("spawn");
    // Numeric code dropped; the accompanying string message carries no token.
    expect(classifySpawnError({ code: 401, message: "boom" })).toBe("spawn");
    // Control: the SAME 429 as a string code IS seen and buckets as rate_limit.
    expect(classifySpawnError({ code: "429" })).toBe("rate_limit");
  });

  it("falls through to 'spawn' for an unrecognized message", () => {
    expect(classifySpawnError("ENOENT: claude binary not found")).toBe("spawn");
    expect(classifySpawnError("some unremarkable failure")).toBe("spawn");
  });
});
