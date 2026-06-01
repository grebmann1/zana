import * as path from "node:path";
import * as fs from "node:fs";
// Lazy — @zana-ai/core may still be loading when this module is first required.
function SETTINGS_PATH(): string {
  return require("@zana-ai/core").config.SETTINGS_PATH;
}

function ensureDir() {
  const dir = path.dirname(SETTINGS_PATH());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function read() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH(), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[settings] read error:", err.message);
    return {};
  }
}

export class SettingsWriteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SettingsWriteError";
  }
}

export function write(settings) {
  try {
    ensureDir();
    const final = SETTINGS_PATH();
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(tmp, final);
  } catch (err) {
    if (err.code === "ENOSPC") throw new SettingsWriteError("disk_full", err.message);
    if (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS") {
      throw new SettingsWriteError("permission_denied", err.message);
    }
    throw new SettingsWriteError("internal", err.message);
  }
}

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const bv = base[k];
    const pv = patch[k];
    out[k] = isPlainObject(bv) && isPlainObject(pv) ? deepMerge(bv, pv) : pv;
  }
  return out;
}

// Returns null on success, otherwise an error string. Validates only the
// top-level keys the codebase actually reads; unknown keys are allowed.
export function validate(input) {
  if (!isPlainObject(input)) return "settings must be an object";
  if ("llm" in input) {
    const llm = input.llm;
    if (!isPlainObject(llm)) return "llm must be an object";
    if ("providers" in llm && !isPlainObject(llm.providers)) return "llm.providers must be an object";
    if ("defaultProvider" in llm && llm.defaultProvider !== null && typeof llm.defaultProvider !== "string") {
      return "llm.defaultProvider must be a string or null";
    }
  }
  if ("plugins" in input && !isPlainObject(input.plugins)) return "plugins must be an object";
  return null;
}

export function getLlmProviders() {
  const settings = read();
  return settings.llm?.providers || {};
}

export function setLlmProvider(id, config) {
  const settings = read();
  if (!settings.llm) settings.llm = {};
  if (!settings.llm.providers) settings.llm.providers = {};
  settings.llm.providers[id] = config;
  write(settings);
}

export function removeLlmProvider(id) {
  const settings = read();
  if (settings.llm?.providers) {
    delete settings.llm.providers[id];
    if (settings.llm.defaultProvider === id) {
      settings.llm.defaultProvider = null;
    }
    write(settings);
  }
}

export function getDefaultProvider() {
  const settings = read();
  return settings.llm?.defaultProvider || null;
}

export function setDefaultProvider(id) {
  const settings = read();
  if (!settings.llm) settings.llm = {};
  settings.llm.defaultProvider = id;
  write(settings);
}

export function getEnvForProvider(providerId) {
  if (!providerId) return {};
  const providers = getLlmProviders();
  const config = providers[providerId];
  if (!config) return {};

  const env = {};

  if (providerId === "anthropic") {
    if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey;
    if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
  } else if (providerId === "openai") {
    if (config.apiKey) env.OPENAI_API_KEY = config.apiKey;
    if (config.baseUrl) env.OPENAI_BASE_URL = config.baseUrl;
  } else if (providerId === "google") {
    if (config.apiKey) env.GOOGLE_API_KEY = config.apiKey;
    if (config.baseUrl) env.GOOGLE_BASE_URL = config.baseUrl;
  } else if (providerId === "sfdc-gateway") {
    // Salesforce LLM Gateway uses Bearer token auth via OpenAI-compatible endpoint
    if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey;
    if (config.baseUrl) {
      env.ANTHROPIC_BASE_URL = config.baseUrl;
      env.OPENAI_BASE_URL = config.baseUrl;
    }
    // Also set OpenAI key for non-anthropic models routed through the gateway
    if (config.apiKey) env.OPENAI_API_KEY = config.apiKey;
  } else {
    // Custom/unknown providers use OpenAI-compatible format
    if (config.apiKey) env.OPENAI_API_KEY = config.apiKey;
    if (config.baseUrl) env.OPENAI_BASE_URL = config.baseUrl;
  }

  return env;
}

export function providerFromModel(modelId) {
  if (!modelId) return null;
  if (modelId.startsWith("us.anthropic.")) return "sfdc-gateway";
  if (modelId.startsWith("claude")) return "anthropic";
  if (["opus", "sonnet", "haiku"].includes(modelId)) return "anthropic";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3")) return "openai";
  if (modelId.startsWith("gemini")) return "google";
  return null;
}

export async function testProvider(id) {
  const providers = getLlmProviders();
  const config = providers[id];
  if (!config) return { ok: false, error: "provider not found" };
  if (!config.apiKey) return { ok: false, error: "no API key configured" };

  const start = Date.now();

  try {
    if (id === "sfdc-gateway") {
      // Salesforce LLM Gateway — test with a lightweight POST (no model list endpoint)
      const baseUrl = config.baseUrl;
      if (!baseUrl) return { ok: false, error: "no gateway URL configured" };
      const headers = { "Content-Type": "application/json" };
      if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
      const res = await fetch(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.defaultModel || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 100)}` };
      }
      return { ok: true, latencyMs: Date.now() - start };
    }

    if (id === "anthropic" || (!["openai", "google"].includes(id) && !config.baseUrl)) {
      const baseUrl = config.baseUrl || "https://api.anthropic.com";
      const res = await fetch(`${baseUrl}/v1/models`, {
        method: "GET",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
      return { ok: true, latencyMs: Date.now() - start };
    }

    if (id === "google") {
      const baseUrl = config.baseUrl || "https://generativelanguage.googleapis.com";
      const res = await fetch(`${baseUrl}/v1beta/models?key=${config.apiKey}`, {
        method: "GET",
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
      return { ok: true, latencyMs: Date.now() - start };
    }

    // OpenAI or custom (OpenAI-compatible)
    const baseUrl = config.baseUrl || "https://api.openai.com";
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

