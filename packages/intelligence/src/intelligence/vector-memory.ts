import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { lazyRequire } from "@zana-ai/contracts";
function _core() { return require("@zana-ai/core"); }
function ZANA_DIR() { return _core().config.ZANA_DIR; }
type EventBusService = typeof import("@zana-ai/core/dist/src/events/service");
const eventBus = lazyRequire<EventBusService>(() => require("@zana-ai/core").events.service);

// ─── Constants ────────────────────────────────────────────────────────────────

function MEMORY_DIR() { return path.join(ZANA_DIR(), "memory"); }
function VECTORS_PATH() { return path.join(MEMORY_DIR(), "vectors.json"); }
function VOCAB_PATH() { return path.join(MEMORY_DIR(), "vocabulary.json"); }

const TTL = { working: 60 * 60 * 1000, episodic: 7 * 24 * 60 * 60 * 1000, semantic: Infinity };
const SAVE_DEBOUNCE_MS = 5000;
const MAINTAIN_INTERVAL_MS = 10 * 60 * 1000;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
  "than", "its", "over", "such", "that", "this", "with", "will", "each",
  "from", "they", "which", "their", "there", "what", "about", "would",
  "make", "like", "just", "into", "could", "time", "very", "when", "come",
]);

// ─── State ────────────────────────────────────────────────────────────────────

let entries = []; // { id, content, embedding, metadata, tier, createdAt }
let vocabulary = {}; // term → idf
let docFreqMap = {}; // term → number of docs containing term
let saveTimer = null;
let maintainTimer = null;
let unsubscribe = null;

// ─── Tokenization ─────────────────────────────────────────────────────────────

function stem(word) {
  return word
    .replace(/tion$/, "")
    .replace(/ment$/, "")
    .replace(/ness$/, "")
    .replace(/able$/, "")
    .replace(/ible$/, "")
    .replace(/ing$/, "")
    .replace(/ly$/, "")
    .replace(/ed$/, "");
}

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map(stem);
}

// ─── TF-IDF ───────────────────────────────────────────────────────────────────

function computeTF(tokens) {
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  const len = tokens.length || 1;
  for (const t in freq) freq[t] /= len;
  return freq;
}

function rebuildVocabulary() {
  docFreqMap = {};
  const totalDocs = entries.length || 1;
  for (const entry of entries) {
    const seen = new Set(tokenize(entry.content));
    for (const term of seen) docFreqMap[term] = (docFreqMap[term] || 0) + 1;
  }
  vocabulary = {};
  for (const term in docFreqMap) {
    vocabulary[term] = Math.log(1 + totalDocs / (1 + docFreqMap[term]));
  }
}

function computeEmbedding(text, useAllTerms) {
  const tokens = tokenize(text);
  const tf = computeTF(tokens);
  const vec = {};
  for (const term in tf) {
    const idf = vocabulary[term];
    if (idf == null && !useAllTerms) continue;
    const score = tf[term] * (idf != null ? idf : Math.log(1 + (entries.length || 1)));
    if (score > 0) vec[term] = score;
  }
  return vec;
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (const k in a) {
    magA += a[k] * a[k];
    if (b[k]) dot += a[k] * b[k];
  }
  for (const k in b) magB += b[k] * b[k];
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk() {
  try {
    if (fs.existsSync(VECTORS_PATH())) {
      entries = JSON.parse(fs.readFileSync(VECTORS_PATH(), "utf8"));
    }
  } catch { entries = []; }
  try {
    if (fs.existsSync(VOCAB_PATH())) {
      vocabulary = JSON.parse(fs.readFileSync(VOCAB_PATH(), "utf8"));
    }
  } catch { vocabulary = {}; }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushToDisk, SAVE_DEBOUNCE_MS);
}

function flushToDisk() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // Tenant isolation gate: refuse to fall back to ~/.zana/memory. Vector
  // memory entries (auto-indexed agent completions) carry workspace-private
  // payloads; the global path is shared across every workspace on the host.
  const ctx = _core().project.workspaceContext;
  if (!ctx.isInitialized()) {
    const ErrCtor = ctx.WorkspaceNotInitializedError;
    throw new ErrCtor({ operation: "write", path: MEMORY_DIR() });
  }
  fs.mkdirSync(MEMORY_DIR(), { recursive: true });
  fs.writeFileSync(VECTORS_PATH(), JSON.stringify(entries), "utf8");
  fs.writeFileSync(VOCAB_PATH(), JSON.stringify(vocabulary), "utf8");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function init() {
  fs.mkdirSync(MEMORY_DIR(), { recursive: true });
  loadFromDisk();
  if (Object.keys(vocabulary).length === 0 && entries.length > 0) rebuildVocabulary();

  // Auto-index agent completions
  unsubscribe = eventBus.subscribe({ types: ["agent:completed"] }, (event) => {
    if (event.payload && event.payload.result) {
      store({
        content: String(event.payload.result),
        metadata: {
          source: "auto-index",
          agentId: event.payload.agentId || event.source,
          ticketId: event.payload.ticketId || null,
          tags: event.payload.tags || [],
          timestamp: event.timestamp || Date.now(),
        },
        tier: "episodic",
      });
    }
  });

  // Periodic maintenance
  maintainTimer = setInterval(maintain, MAINTAIN_INTERVAL_MS);
}

export function store({ content, metadata = {}, tier = "episodic" }) {
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  // Update vocabulary incrementally
  const tokens = new Set(tokenize(content));
  const totalDocs = entries.length + 1;
  for (const term of tokens) {
    docFreqMap[term] = (docFreqMap[term] || 0) + 1;
    vocabulary[term] = Math.log(1 + totalDocs / (1 + docFreqMap[term]));
  }

  const embedding = computeEmbedding(content, true);
  const entry = { id, content, embedding, metadata: { ...metadata, timestamp: metadata.timestamp || createdAt }, tier, createdAt };
  entries.push(entry);
  scheduleSave();
  eventBus.emit("memory:stored", { id, tier });
  return { id, tier };
}

export function search(query, options = {}) {
  const { limit = 10, minScore = 0.1, tier = null, tags = [] } = options;
  const qVec = computeEmbedding(query);

  let results = [];
  for (const entry of entries) {
    if (tier && entry.tier !== tier) continue;
    if (tags.length > 0 && (!entry.metadata.tags || !tags.some((t) => entry.metadata.tags.includes(t)))) continue;
    const score = cosineSimilarity(qVec, entry.embedding);
    if (score >= minScore) results.push({ id: entry.id, content: entry.content, metadata: entry.metadata, score, tier: entry.tier });
  }

  results.sort((a, b) => b.score - a.score);
  const out = results.slice(0, limit);
  eventBus.emit("memory:searched", { query, resultsCount: out.length });
  return out;
}

export function get(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  return { id: entry.id, content: entry.content, metadata: entry.metadata, tier: entry.tier, createdAt: entry.createdAt };
}

function del(id) {
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  scheduleSave();
  return true;
}

export function promote(id, newTier) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;
  entry.tier = newTier;
  entry.createdAt = Date.now(); // reset TTL clock
  scheduleSave();
  return true;
}

export function stats() {
  const byTier = { working: 0, episodic: 0, semantic: 0 };
  for (const e of entries) byTier[e.tier] = (byTier[e.tier] || 0) + 1;
  return { total: entries.length, byTier, vocabularySize: Object.keys(vocabulary).length };
}

export function maintain() {
  const now = Date.now();
  let expired = 0;
  let consolidated = 0;

  entries = entries.filter((e) => {
    const ttl = TTL[e.tier];
    if (ttl !== Infinity && now - e.createdAt > ttl) { expired++; return false; }
    return true;
  });

  // Consolidate: promote episodic entries referenced more than once (high overlap) to semantic
  const episodic = entries.filter((e) => e.tier === "episodic");
  for (let i = 0; i < episodic.length; i++) {
    let overlapCount = 0;
    for (let j = i + 1; j < episodic.length; j++) {
      if (cosineSimilarity(episodic[i].embedding, episodic[j].embedding) > 0.8) overlapCount++;
    }
    if (overlapCount >= 2) {
      episodic[i].tier = "semantic";
      episodic[i].createdAt = now;
      consolidated++;
    }
  }

  if (expired > 0 || consolidated > 0) {
    rebuildVocabulary();
    scheduleSave();
  }
  if (expired > 0) eventBus.emit("memory:expired", { expired, consolidated });
  return { expired, consolidated };
}

export function shutdown() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (maintainTimer) { clearInterval(maintainTimer); maintainTimer = null; }
  flushToDisk();
}

export { del as delete };