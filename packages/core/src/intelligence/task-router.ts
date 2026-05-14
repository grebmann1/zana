import * as fs from "node:fs";
import * as path from "node:path";
import { ZANA_DIR } from "../config";
import * as eventBus from "../events/service";
import * as profileStore from "../agents/profile-store";

// ─── Constants ──────────────────────────────────────────────────────────────

const WEIGHTS = { label: 0.35, keyword: 0.25, successRate: 0.25, recency: 0.15 };
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HISTORY_PATH = path.join(ZANA_DIR, "routing-history.json");

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "about",
  "that", "this", "it", "its", "and", "or", "but", "if", "not", "no",
  "so", "than", "too", "very", "just", "also", "then", "when", "what",
]);

// ─── State ──────────────────────────────────────────────────────────────────

let outcomes = [];
let db = null;
let initialized = false;

// ─── SQLite helpers ─────────────────────────────────────────────────────────

function initSqlite() {
  try {
    const Database = require("better-sqlite3");
    const dbPath = path.join(ZANA_DIR, "routing.db");
    fs.mkdirSync(ZANA_DIR, { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS routing_outcomes (
        id INTEGER PRIMARY KEY,
        ticket_id TEXT,
        profile_id TEXT,
        success INTEGER,
        duration_ms INTEGER,
        labels TEXT,
        keywords TEXT,
        created_at TEXT
      )
    `);
  } catch {
    db = null;
  }
}

function loadOutcomes() {
  if (db) {
    const rows = db.prepare("SELECT * FROM routing_outcomes ORDER BY created_at DESC").all();
    outcomes = rows.map((r) => ({
      ticketId: r.ticket_id,
      profileId: r.profile_id,
      success: !!r.success,
      duration: r.duration_ms,
      labels: JSON.parse(r.labels || "[]"),
      keywords: JSON.parse(r.keywords || "[]"),
      createdAt: r.created_at,
    }));
  } else if (fs.existsSync(HISTORY_PATH)) {
    try {
      outcomes = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    } catch {
      outcomes = [];
    }
  }
}

function persistOutcome(outcome) {
  if (db) {
    db.prepare(`
      INSERT INTO routing_outcomes (ticket_id, profile_id, success, duration_ms, labels, keywords, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      outcome.ticketId,
      outcome.profileId,
      outcome.success ? 1 : 0,
      outcome.duration || null,
      JSON.stringify(outcome.labels || []),
      JSON.stringify(outcome.keywords || []),
      outcome.createdAt
    );
  } else {
    fs.mkdirSync(ZANA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(outcomes, null, 2), "utf8");
  }
}

// ─── Text extraction ────────────────────────────────────────────────────────

function extractKeywords(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s\-_.,;:!?()\[\]{}"'/\\|<>@#$%^&*+=~`]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// ─── Scoring helpers ────────────────────────────────────────────────────────

function labelScore(ticketLabels, profileOutcomes) {
  if (!ticketLabels.length || !profileOutcomes.length) return 0;
  const successLabels = new Set();
  for (const o of profileOutcomes) {
    if (o.success) for (const l of o.labels) successLabels.add(l);
  }
  if (!successLabels.size) return 0;
  let matches = 0;
  for (const l of ticketLabels) if (successLabels.has(l)) matches++;
  return matches / ticketLabels.length;
}

function keywordScore(ticketKeywords, profileOutcomes) {
  if (!ticketKeywords.length || !profileOutcomes.length) return 0;
  const successKeywordCounts = {};
  let totalDocs = 0;
  for (const o of profileOutcomes) {
    if (!o.success) continue;
    totalDocs++;
    const seen = new Set(o.keywords);
    for (const kw of seen) successKeywordCounts[kw] = (successKeywordCounts[kw] || 0) + 1;
  }
  if (!totalDocs) return 0;

  let score = 0;
  const ticketSet = new Set(ticketKeywords);
  for (const kw of ticketSet) {
    if (successKeywordCounts[kw]) {
      // TF-IDF-like: higher score for rarer keywords that match
      const idf = Math.log((totalDocs + 1) / (successKeywordCounts[kw] + 1)) + 1;
      score += idf;
    }
  }
  // Normalize by ticket keyword count
  const maxPossible = ticketSet.size * (Math.log(totalDocs + 1) + 1);
  return maxPossible > 0 ? Math.min(score / maxPossible, 1) : 0;
}

function successRateScore(profileOutcomes) {
  // Laplace smoothing: (successes + 1) / (attempts + 2)
  const successes = profileOutcomes.filter((o) => o.success).length;
  return (successes + 1) / (profileOutcomes.length + 2);
}

function recencyScore(profileOutcomes) {
  if (!profileOutcomes.length) return 0;
  const now = Date.now();
  let total = 0;
  let count = 0;
  for (const o of profileOutcomes) {
    if (!o.success) continue;
    const age = now - new Date(o.createdAt).getTime();
    total += Math.pow(0.5, age / HALF_LIFE_MS);
    count++;
  }
  return count > 0 ? total / count : 0;
}

function profileCapabilityScore(ticketKeywords, profile) {
  // Fallback: match ticket keywords against profile description
  const desc = (profile.description || "") + " " + (profile.displayName || "");
  const profileKws = extractKeywords(desc);
  if (!profileKws.length || !ticketKeywords.length) return 0;
  const profileSet = new Set(profileKws);
  let matches = 0;
  for (const kw of ticketKeywords) if (profileSet.has(kw)) matches++;
  return matches / ticketKeywords.length;
}

function bestReason(ticketLabels, ticketKeywords, profileOutcomes, profile) {
  const ls = labelScore(ticketLabels, profileOutcomes);
  const ks = keywordScore(ticketKeywords, profileOutcomes);
  const sr = successRateScore(profileOutcomes);
  const cap = profileCapabilityScore(ticketKeywords, profile);

  const reasons = [
    { score: ls, text: `high success with '${ticketLabels[0] || ""}' label` },
    { score: ks, text: `keyword match: ${ticketKeywords.slice(0, 3).join(", ")}` },
    { score: sr, text: `strong overall success rate` },
    { score: cap, text: `profile capabilities match task description` },
  ];
  reasons.sort((a, b) => b.score - a.score);
  return reasons[0].text;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function init() {
  if (initialized) return;
  initialized = true;
  initSqlite();
  loadOutcomes();
}

export function route(ticket) {
  if (!initialized) init();

  const ticketLabels = (ticket.labels || []).map((l) => l.toLowerCase());
  const ticketText = [ticket.title || "", ticket.description || ""].join(" ");
  const ticketKeywords = extractKeywords(ticketText);

  const profiles = profileStore.listProfiles();
  const hasHistory = outcomes.length > 0;

  const scored = profiles.map((profile) => {
    const profileOutcomes = outcomes.filter((o) => o.profileId === profile.id);

    let score;
    if (hasHistory && profileOutcomes.length > 0) {
      const ls = labelScore(ticketLabels, profileOutcomes);
      const ks = keywordScore(ticketKeywords, profileOutcomes);
      const sr = successRateScore(profileOutcomes);
      const rs = recencyScore(profileOutcomes);
      score = WEIGHTS.label * ls + WEIGHTS.keyword * ks + WEIGHTS.successRate * sr + WEIGHTS.recency * rs;
    } else {
      // No history for this profile — fall back to capability matching
      score = profileCapabilityScore(ticketKeywords, profile) * 0.5;
    }

    const reason = hasHistory && profileOutcomes.length > 0
      ? bestReason(ticketLabels, ticketKeywords, profileOutcomes, profile)
      : `profile capabilities match task description`;

    return { profileId: profile.id, score: Math.round(score * 1000) / 1000, reason };
  });

  scored.sort((a, b) => b.score - a.score);
  const result = scored.filter((s) => s.score > 0);

  eventBus.emit("routing:decision", { ticketId: ticket.id, rankings: result.slice(0, 5) });
  return result;
}

export function recordOutcome({ ticketId, profileId, success, duration, labels, keywords }) {
  if (!initialized) init();

  const outcome = {
    ticketId,
    profileId,
    success: !!success,
    duration: duration || null,
    labels: (labels || []).map((l) => l.toLowerCase()),
    keywords: keywords || [],
    createdAt: new Date().toISOString(),
  };

  outcomes.unshift(outcome);
  persistOutcome(outcome);

  eventBus.emit("routing:outcome-recorded", { ticketId, profileId, success });
}

export function getStats() {
  if (!initialized) init();

  const profileStats = {};
  for (const o of outcomes) {
    if (!profileStats[o.profileId]) {
      profileStats[o.profileId] = { attempts: 0, successes: 0, totalDuration: 0 };
    }
    const ps = profileStats[o.profileId];
    ps.attempts++;
    if (o.success) ps.successes++;
    if (o.duration) ps.totalDuration += o.duration;
  }

  for (const id of Object.keys(profileStats)) {
    const ps = profileStats[id];
    ps.avgDuration = ps.attempts > 0 ? Math.round(ps.totalDuration / ps.attempts) : 0;
    delete ps.totalDuration;
  }

  return { totalOutcomes: outcomes.length, profileStats };
}

export function reset() {
  outcomes = [];
  if (db) {
    db.exec("DELETE FROM routing_outcomes");
  } else if (fs.existsSync(HISTORY_PATH)) {
    fs.unlinkSync(HISTORY_PATH);
  }
}

