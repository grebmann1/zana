// Unit tests for packages/server/src/api/auth-middleware.ts
// Covers: ALLOWED_ORIGINS set, isAllowedOrigin, getCorsOrigin, authenticate.
// Uses the static-token init() path — no real fs reads or writes.

import { describe, it, expect, beforeEach } from "vitest";
import * as auth from "../../src/api/auth-middleware.ts";

const TOKEN = "test-secret-token-abc123";

// Re-initialise with a known static token before each test so state is clean.
beforeEach(() => {
  auth.init({ token: TOKEN });
});

// ---------------------------------------------------------------------------
// ALLOWED_ORIGINS
// ---------------------------------------------------------------------------
describe("ALLOWED_ORIGINS", () => {
  it("contains the canonical localhost and 127.0.0.1 dev origins", () => {
    expect(auth.ALLOWED_ORIGINS.has("http://localhost:3000")).toBe(true);
    expect(auth.ALLOWED_ORIGINS.has("http://localhost:3020")).toBe(true);
    expect(auth.ALLOWED_ORIGINS.has("http://127.0.0.1:3000")).toBe(true);
    expect(auth.ALLOWED_ORIGINS.has("http://127.0.0.1:3020")).toBe(true);
  });

  it("does not contain external or HTTPS origins", () => {
    expect(auth.ALLOWED_ORIGINS.has("https://localhost:3000")).toBe(false);
    expect(auth.ALLOWED_ORIGINS.has("http://evil.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAllowedOrigin
// ---------------------------------------------------------------------------
describe("isAllowedOrigin", () => {
  it("returns true for an allowed origin", () => {
    expect(auth.isAllowedOrigin("http://localhost:3000")).toBe(true);
  });

  it("returns false for an unknown origin", () => {
    expect(auth.isAllowedOrigin("http://attacker.com")).toBe(false);
  });

  it("returns true when origin is undefined (same-origin / direct requests)", () => {
    expect(auth.isAllowedOrigin(undefined)).toBe(true);
  });

  it("returns true when origin is empty string", () => {
    expect(auth.isAllowedOrigin("")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getCorsOrigin
// ---------------------------------------------------------------------------
describe("getCorsOrigin", () => {
  it("returns the origin header when it is allowed", () => {
    const req = { headers: { origin: "http://localhost:3020" } };
    expect(auth.getCorsOrigin(req)).toBe("http://localhost:3020");
  });

  it("returns null when origin header is absent", () => {
    const req = { headers: {} };
    expect(auth.getCorsOrigin(req)).toBeNull();
  });

  it("returns null when origin header is not in ALLOWED_ORIGINS", () => {
    const req = { headers: { origin: "http://evil.com" } };
    expect(auth.getCorsOrigin(req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// authenticate
// ---------------------------------------------------------------------------
describe("authenticate", () => {
  function makeReq(token: string, origin?: string) {
    return {
      headers: {
        authorization: `Bearer ${token}`,
        ...(origin !== undefined ? { origin } : {}),
      },
    };
  }

  it("returns true for a valid token with no origin header", () => {
    expect(auth.authenticate(makeReq(TOKEN))).toBe(true);
  });

  it("returns true for a valid token from an allowed origin", () => {
    expect(auth.authenticate(makeReq(TOKEN, "http://localhost:3000"))).toBe(true);
  });

  it("returns false when the token is wrong", () => {
    expect(auth.authenticate(makeReq("wrong-token"))).toBe(false);
  });

  it("returns false when the origin is not allowed", () => {
    expect(auth.authenticate(makeReq(TOKEN, "http://evil.com"))).toBe(false);
  });

  it("returns false when authorization header is missing", () => {
    const req = { headers: {} };
    expect(auth.authenticate(req)).toBe(false);
  });

  it("returns false when authorization scheme is not Bearer", () => {
    const req = { headers: { authorization: `Basic ${TOKEN}` } };
    expect(auth.authenticate(req)).toBe(false);
  });

  it("returns false when authorization header has extra parts", () => {
    const req = { headers: { authorization: `Bearer ${TOKEN} extra` } };
    expect(auth.authenticate(req)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getToken
// ---------------------------------------------------------------------------
describe("getToken", () => {
  it("returns the token set via init()", () => {
    expect(auth.getToken()).toBe(TOKEN);
  });

  it("returns a different token after re-initialising with a new static token", () => {
    auth.init({ token: "new-token-xyz" });
    expect(auth.getToken()).toBe("new-token-xyz");
    // Restore for other tests
    auth.init({ token: TOKEN });
  });
});
