import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { config } from "@zana-ai/core";
function TEAMS_DIR() { return config.TEAMS_DIR; }

function ensureDir() {
  fs.mkdirSync(TEAMS_DIR(), { recursive: true });
}

export function listTeams() {
  ensureDir();
  try {
    const files = fs.readdirSync(TEAMS_DIR()).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(TEAMS_DIR(), f), "utf8"));
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9\-_]/g, "");
}

export function getTeam(id) {
  if (!id) return null;
  ensureDir();
  const filePath = path.join(TEAMS_DIR(), `${sanitizeId(id)}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function saveTeam(team) {
  ensureDir();
  const now = new Date().toISOString();
  if (!team.id) {
    team.id = crypto.randomUUID();
    team.createdAt = now;
  } else {
    const clean = sanitizeId(String(team.id));
    if (!clean || clean !== team.id) {
      throw new Error(`saveTeam: invalid team.id "${team.id}" — must match [a-zA-Z0-9_-]+`);
    }
    team.id = clean;
  }
  team.updatedAt = now;

  if (!team.name) team.name = "Untitled Team";
  if (!team.icon) team.icon = "🏗️";
  if (!team.orchestratorProfileId) team.orchestratorProfileId = "orchestrator";
  if (!Array.isArray(team.workerProfileIds)) team.workerProfileIds = [];

  // Normalize slots
  if (Array.isArray(team.slots)) {
    team.slots = team.slots
      .filter((s) => s.profileId && typeof s.quantity === "number" && s.quantity >= 1)
      .map((s) => ({ profileId: s.profileId, quantity: Math.min(Math.max(1, Math.round(s.quantity)), 10) }));
    team.workerProfileIds = [...new Set(team.slots.map((s) => s.profileId))];
  } else if (team.workerProfileIds.length > 0) {
    team.slots = team.workerProfileIds.map((id) => ({ profileId: id, quantity: 1 }));
  } else {
    team.slots = [];
  }

  if (!team.rules) team.rules = {};
  if (team.rules.maxConcurrentWorkers === undefined) {
    team.rules.maxConcurrentWorkers = Math.max(3, team.slots.reduce((sum, s) => sum + s.quantity, 0));
  }
  if (team.rules.autoRestart === undefined) team.rules.autoRestart = false;
  if (team.rules.requireApproval === undefined) team.rules.requireApproval = false;
  if (team.autoStart === undefined) team.autoStart = false;
  if (team.dynamicSpawning === undefined) team.dynamicSpawning = false;
  if (team.maxTotalWorkers === undefined) team.maxTotalWorkers = team.rules.maxConcurrentWorkers || 10;
  if (!team.initialPrompt) team.initialPrompt = "";

  const filePath = path.join(TEAMS_DIR(), `${team.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(team, null, 2) + "\n", "utf8");
  return team;
}

export function deleteTeam(id) {
  if (!id) return false;
  const filePath = path.join(TEAMS_DIR(), `${sanitizeId(id)}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

const TEAM_TEMPLATES = [
  {
    name: "Engineering Squad",
    icon: "🏗️",
    description: "Full-stack engineering team for feature development",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "full-auto-coder", quantity: 3 },
      { profileId: "code-reviewer", quantity: 1 },
      { profileId: "test-writer", quantity: 2 },
      { profileId: "doc-generator", quantity: 1 },
    ],
    initialPrompt: "You lead an engineering squad. Assign coding tasks to your coders in parallel, send completed code to the reviewer, ensure test coverage via test writers, and produce documentation when done.",
    rules: { maxConcurrentWorkers: 7, autoRestart: false, requireApproval: false },
  },
  {
    name: "Frontend Squad",
    icon: "🎨",
    description: "UI-focused team: architect plans structure, designer handles UX/styling, frontend dev implements",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "architect", quantity: 1 },
      { profileId: "ux-designer", quantity: 1 },
      { profileId: "frontend-dev", quantity: 2 },
    ],
    initialPrompt: "You lead a frontend team. Workflow:\n1. Spawn the Architect FIRST to plan file structure, component boundaries, and data shapes. Wait for its result.\n2. Spawn the UX Designer to create the visual design (CSS, layout, color scheme). Wait for its result.\n3. Spawn Frontend Developers to implement the full application using the architect's plan and designer's styles.\n4. Review the final output for completeness.",
    rules: { maxConcurrentWorkers: 4, autoRestart: false, requireApproval: false },
  },
  {
    name: "Backend Squad",
    icon: "⚙️",
    description: "Logic-focused team: architect plans structure, backend dev implements, test writer validates",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "architect", quantity: 1 },
      { profileId: "backend-dev", quantity: 2 },
      { profileId: "test-writer", quantity: 1 },
    ],
    initialPrompt: "You lead a backend team. Workflow:\n1. Spawn the Architect FIRST to plan the system design — data models, API contracts, file structure. Wait for its result.\n2. Spawn Backend Developers to implement the system from the architect's specs.\n3. Spawn the Test Writer to create tests for the implementation.\n4. Review all outputs for correctness and completeness.",
    rules: { maxConcurrentWorkers: 4, autoRestart: false, requireApproval: false },
  },
  {
    name: "Fullstack Squad",
    icon: "🚀",
    description: "Complete team: architect, designer, frontend dev, backend dev, and code reviewer",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "architect", quantity: 1 },
      { profileId: "ux-designer", quantity: 1 },
      { profileId: "frontend-dev", quantity: 1 },
      { profileId: "backend-dev", quantity: 1 },
      { profileId: "code-reviewer", quantity: 1 },
    ],
    initialPrompt: "You lead a fullstack team. Workflow:\n1. Spawn the Architect to plan the overall structure and component boundaries. Wait for its result.\n2. Spawn the UX Designer in parallel with the Backend Developer — designer works on UI, backend dev works on data/logic.\n3. Spawn the Frontend Developer to integrate the design with the backend.\n4. Spawn the Code Reviewer to check the final implementation.\n5. Report results.",
    rules: { maxConcurrentWorkers: 5, autoRestart: false, requireApproval: false },
  },
  {
    name: "Code Review Squad",
    icon: "🔍",
    description: "PR review pipeline: two reviewers cross-check, security reviewer audits, test-writer flags missing coverage",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "code-reviewer", quantity: 2 },
      { profileId: "security-reviewer", quantity: 1 },
      { profileId: "test-writer", quantity: 1 },
    ],
    initialPrompt: "You run a PR review. Workflow:\n1. Spawn both Code Reviewers in parallel on the same diff — collect their independent findings.\n2. Spawn the Security Reviewer with the diff — auth, injection, secrets, supply chain, deserialization.\n3. Spawn the Test Writer — identify behaviors the diff changes that lack test coverage.\n4. Synthesize all findings into a single review with severity-ranked issues. Do not write fixes; surface the gaps.",
    rules: { maxConcurrentWorkers: 4, autoRestart: false, requireApproval: false },
  },
  {
    name: "Research & Docs Squad",
    icon: "🔬",
    description: "Read-only investigation: researchers explore, architect frames the problem, doc-generator writes it up",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "researcher", quantity: 2 },
      { profileId: "architect", quantity: 1 },
      { profileId: "doc-generator", quantity: 1 },
    ],
    initialPrompt: "You lead a research investigation. Workflow:\n1. Split the question across both Researchers — give each a distinct sub-area to explore. Wait for both.\n2. Spawn the Architect with both research outputs — ask for a framing of the problem space, options compared, and a recommendation with tradeoffs.\n3. Spawn the Doc Generator with all prior outputs — produce a single consolidated writeup.\nThis squad does NOT write production code. Outputs are RFCs, design docs, or analysis artifacts.",
    rules: { maxConcurrentWorkers: 4, autoRestart: false, requireApproval: false },
  },
  {
    name: "Debug Squad",
    icon: "🐛",
    description: "Repro-first bug hunt: debuggers reproduce and bisect, test-writer locks the regression, code-reviewer signs off the fix",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "debugger", quantity: 2 },
      { profileId: "test-writer", quantity: 1 },
      { profileId: "code-reviewer", quantity: 1 },
    ],
    initialPrompt: "You lead a bug investigation. Workflow:\n1. Spawn both Debuggers — one builds the minimal reproduction, the other bisects to root cause. Both run in parallel.\n2. Spawn the Test Writer with the reproduction — write a failing test that pins the bug before any fix lands.\n3. Wait for the Debuggers to land the fix; then spawn the Code Reviewer on the diff.\n4. Confirm the regression test now passes and report root cause + fix in the final summary.",
    rules: { maxConcurrentWorkers: 4, autoRestart: false, requireApproval: false },
  },
  {
    name: "Performance Squad",
    icon: "⚡",
    description: "Profile-and-improve loop: performance engineer measures, researcher digs into hotspots, backend dev applies the fix",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "performance-engineer", quantity: 1 },
      { profileId: "researcher", quantity: 1 },
      { profileId: "backend-dev", quantity: 1 },
    ],
    initialPrompt: "You lead a performance investigation. Workflow:\n1. Spawn the Performance Engineer FIRST to set up benchmarks and capture baseline numbers (latency, throughput, memory). Wait for its result.\n2. Spawn the Researcher with the baseline — identify the top 1-3 hotspots and explain *why* they're slow (algorithmic, IO-bound, allocation pressure, lock contention).\n3. Spawn the Backend Dev with the hotspot analysis — apply targeted fixes, no scope creep.\n4. Re-run the benchmarks via Performance Engineer; report before/after numbers and which fix moved which metric.",
    rules: { maxConcurrentWorkers: 3, autoRestart: false, requireApproval: false },
  },
];

export function getTemplates() {
  const templates = [...TEAM_TEMPLATES];
  try {
    const pluginLoader = require("@zana-ai/extras").plugins.loader;
    const pluginFiles = pluginLoader.getContributions("teamTemplates");
    for (const filePath of pluginFiles) {
      if (!filePath.endsWith(".json") || !fs.existsSync(filePath)) continue;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        templates.push(JSON.parse(raw));
      } catch (err) {
        console.warn(`[team-store] failed to load plugin template ${filePath}:`, err.message);
      }
    }
  } catch {
    // plugin-loader not yet initialized
  }
  return templates;
}

function templateId(t) {
  return String(t.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// One-time seed of built-in TEAM_TEMPLATES into ~/.zana/teams/. Tracks which
// template ids have been seeded in a `.seeded` marker so that a user who
// deletes a default team does not see it auto-recreate on the next boot. New
// templates added in future versions are still seeded (their id isn't in the
// marker yet); previously-seeded ids that were deleted stay deleted.
export function seedDefaults() {
  ensureDir();
  const markerPath = path.join(TEAMS_DIR(), ".seeded");
  let seeded;
  try {
    seeded = new Set(JSON.parse(fs.readFileSync(markerPath, "utf8")));
  } catch {
    seeded = new Set();
  }

  let changed = false;
  for (const tpl of TEAM_TEMPLATES) {
    const id = templateId(tpl);
    if (!id) continue;
    if (seeded.has(id)) continue;
    const filePath = path.join(TEAMS_DIR(), `${id}.json`);
    if (!fs.existsSync(filePath)) {
      try {
        saveTeam({ ...tpl, id });
      } catch (err) {
        console.warn(`[team-store] seed ${id} failed:`, err.message);
        continue;
      }
    }
    seeded.add(id);
    changed = true;
  }

  if (changed) {
    try {
      fs.writeFileSync(markerPath, JSON.stringify([...seeded], null, 2), "utf8");
    } catch (err) {
      console.warn(`[team-store] write seed marker failed:`, err.message);
    }
  }
}

