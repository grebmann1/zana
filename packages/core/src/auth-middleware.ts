import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const AUTH_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".zana",
  "auth.json"
);

let config = null;

export const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:3020",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3020",
]);

export function init(options = {}) {
  if (options.token) {
    config = { mode: "static", token: options.token };
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    config = { mode: "file", token: raw.token, createdAt: raw.createdAt };
  } catch {
    const token = crypto.randomBytes(32).toString("hex");
    config = { mode: "file", token, createdAt: Date.now() };
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }
}

export function getToken() {
  if (!config) init();
  return config.token;
}

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

export function getCorsOrigin(req) {
  const origin = req.headers["origin"];
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  return null;
}

export function authenticate(req) {
  if (!config) return false;

  const origin = req.headers["origin"];
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;

  const auth = req.headers["authorization"];
  if (!auth) return false;

  const parts = auth.split(" ");
  if (parts[0] !== "Bearer" || parts.length !== 2) return false;

  return timingSafeEquals(parts[1], config.token);
}

function timingSafeEquals(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

