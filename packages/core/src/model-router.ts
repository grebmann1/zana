const TIERS = {
  HAIKU:  "claude-haiku-4-5",
  SONNET: "claude-sonnet-4-6",
  OPUS:   "claude-opus-4-6",
};

const HAIKU_KEYWORDS  = ["list", "status", "check", "what is", "show"];
const OPUS_KEYWORDS   = ["design", "architect", "refactor across", "security"];
const OPUS_CATEGORIES = ["security"];
const SONNET_CATEGORIES = ["code-review", "analysis"];

function selectModel(prompt, profileHints = {}) {
  // User override — always respect explicit model
  if (profileHints.model) return profileHints.model;

  const text = (prompt || "").toLowerCase();
  const len = text.length;

  // Length-based fast paths
  if (len > 2000) return TIERS.OPUS;

  // Keyword checks (order matters: check Opus first, then Haiku)
  if (OPUS_KEYWORDS.some((kw) => text.includes(kw))) return TIERS.OPUS;
  if (len < 200 && HAIKU_KEYWORDS.some((kw) => text.includes(kw))) {
    return TIERS.HAIKU;
  }

  // Category-based routing
  const category = (profileHints.category || "").toLowerCase();
  if (OPUS_CATEGORIES.includes(category)) return TIERS.OPUS;
  if (SONNET_CATEGORIES.includes(category)) return TIERS.SONNET;

  // Default
  return TIERS.SONNET;
}

module.exports = { selectModel, TIERS };
