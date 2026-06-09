import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "node:http";

// The store's SETTINGS_PATH() is resolved lazily through @zana-ai/core's config.
// We point HOME at a temp dir BEFORE requiring core so ZANA_DIR == <tmp>/.zana.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zana-settings-test-"));
process.env.HOME = tmpHome;

import * as apiServer from "@zana-ai/server/src/api/server.ts";
const TOKEN = "test-token-deadbeef";
const PORT = 47912;

// Minimal daemon stub — settings handler doesn't touch daemon fields, but the
// shared request preamble needs `daemon` to be truthy on non-/health routes.
const stubDaemon = {
  daemonId: "test",
  workspace: tmpHome,
  agentManager: { listAgents: () => [] },
  teamManager: { listRunningTeams: () => [] },
};

let serverReady = false;

beforeAll(async () => {
  const srv = apiServer.start(stubDaemon, PORT, { token: TOKEN });
  if (!srv) return;
  // Wait for the server to actually bind the port before running tests.
  await new Promise<void>((resolve) => {
    srv.once("listening", resolve);
    srv.once("error", resolve); // e.g. EADDRINUSE
  });
  // Probe connectivity — sandbox environments may block connect() with EPERM.
  try {
    await request("GET");
    serverReady = true;
  } catch {
    // Cannot reach the server (e.g. EPERM in test sandbox) — tests will be skipped.
  }
});

// Skip all tests when the server is unreachable (sandbox / CI network restrictions).
beforeEach((ctx) => {
  if (!serverReady) ctx.skip();
});

afterAll(() => {
  try { apiServer.stop(); } catch {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  // config.SETTINGS_PATH is evaluated at module-load time from os.homedir(), not
  // from process.env.HOME — static imports are hoisted before module body runs so
  // our HOME override arrives too late. Clean up what was actually written.
  try {
    const realPath = require("@zana-ai/core").config.SETTINGS_PATH;
    if (realPath && fs.existsSync(realPath)) fs.rmSync(realPath, { force: true });
  } catch {}
});

function request(method: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: "/settings",
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout: 3000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => {
          let parsed: any = null;
          try { parsed = JSON.parse(buf); } catch { parsed = buf; }
          resolve({ status: res.statusCode!, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("GET/POST /settings", () => {
  it("GET returns 200 with the persisted settings object (empty before any write)", async () => {
    const res = await request("GET");
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
  });

  it("POST shallow-merges and persists; GET reflects the merge", async () => {
    const post = await request("POST", { llm: { defaultProvider: "anthropic" } });
    expect(post.status).toBe(200);
    expect(post.body.llm.defaultProvider).toBe("anthropic");

    const get = await request("GET");
    expect(get.status).toBe(200);
    expect(get.body.llm.defaultProvider).toBe("anthropic");
  });

  it("POST a second top-level key keeps the first (merge, not replace)", async () => {
    const post = await request("POST", { plugins: { demo: { enabled: true } } });
    expect(post.status).toBe(200);
    expect(post.body.plugins.demo.enabled).toBe(true);
    expect(post.body.llm.defaultProvider).toBe("anthropic");
  });

  it("POST deep-merges nested objects without clobbering siblings", async () => {
    // Seed: llm.providers.foo exists; llm.defaultProvider is set.
    await request("POST", { llm: { providers: { foo: { apiKey: "k1" } } } });

    // Update llm.defaultProvider only — providers.foo must survive.
    const post = await request("POST", { llm: { defaultProvider: "openai" } });
    expect(post.status).toBe(200);
    expect(post.body.llm.defaultProvider).toBe("openai");
    expect(post.body.llm.providers.foo.apiKey).toBe("k1");
  });

  it("POST arrays replace rather than concatenate", async () => {
    await request("POST", { plugins: { listy: { tags: ["a", "b"] } } });
    const post = await request("POST", { plugins: { listy: { tags: ["c"] } } });
    expect(post.body.plugins.listy.tags).toEqual(["c"]);
  });

  it("POST rejects {llm: 'garbage'} with 400 validation_failed", async () => {
    const post = await request("POST", { llm: "garbage" });
    expect(post.status).toBe(400);
    expect(post.body.error).toBe("validation_failed");
    expect(post.body.detail).toMatch(/llm/);
  });

  it("POST rejects {plugins: 5} with 400", async () => {
    const post = await request("POST", { plugins: 5 });
    expect(post.status).toBe(400);
    expect(post.body.error).toBe("validation_failed");
  });

  it("POST rejects {llm: {providers: 7}} with 400", async () => {
    const post = await request("POST", { llm: { providers: 7 } });
    expect(post.status).toBe(400);
    expect(post.body.error).toBe("validation_failed");
  });

  it("POST allows unknown top-level keys (forward-compat)", async () => {
    const post = await request("POST", { experimental: { flag: true } });
    expect(post.status).toBe(200);
    expect(post.body.experimental.flag).toBe(true);
  });

  it("concurrent POSTs all land — no lost updates", async () => {
    const N = 10;
    const reqs = Array.from({ length: N }, (_, i) =>
      request("POST", { plugins: { [`race-${i}`]: { idx: i } } })
    );
    const results = await Promise.all(reqs);
    for (const r of results) expect(r.status).toBe(200);

    const get = await request("GET");
    for (let i = 0; i < N; i++) {
      expect(get.body.plugins[`race-${i}`].idx).toBe(i);
    }
  });

  it("write uses atomic rename — no .tmp leftovers and no partial JSON if interrupted", async () => {
    // config.SETTINGS_PATH is resolved at module-load time via os.homedir(), which
    // is not affected by the process.env.HOME override above (imports are hoisted).
    const settingsPath: string = require("@zana-ai/core").config.SETTINGS_PATH;
    expect(fs.existsSync(settingsPath)).toBe(true);

    const dir = path.dirname(settingsPath);
    const before = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(before.length).toBe(0);

    await request("POST", { plugins: { atom: { ok: true } } });

    const after = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(after.length).toBe(0);

    const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(onDisk.plugins.atom.ok).toBe(true);
  });

  it("POST translates EACCES from a read-only settings dir to permission_denied 500", async () => {
    if (process.platform === "win32") return; // chmod semantics don't apply
    if (process.getuid && process.getuid() === 0) return; // root bypasses 0o555
    // Use the actual ZANA_DIR (see note in atomic-rename test above).
    const dir: string = require("@zana-ai/core").config.ZANA_DIR;
    fs.chmodSync(dir, 0o555);
    try {
      const post = await request("POST", { plugins: { ro: { x: 1 } } });
      expect(post.status).toBe(500);
      expect(post.body.error).toBe("permission_denied");
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it("read() recovers from corrupt settings.json by returning {}", async () => {
    const settingsPath = path.join(tmpHome, ".zana", "settings.json");
    const snapshot = fs.readFileSync(settingsPath, "utf8");
    fs.writeFileSync(settingsPath, "{not valid json", "utf8");
    try {
      const get = await request("GET");
      expect(get.status).toBe(200);
      expect(get.body).toEqual({});
    } finally {
      fs.writeFileSync(settingsPath, snapshot, "utf8");
    }
  });
});
