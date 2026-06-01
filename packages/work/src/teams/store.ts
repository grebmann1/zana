import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
function TEAMS_DIR() { return require("@zana-ai/core").config.TEAMS_DIR; }

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
    name: "Research Team",
    icon: "🔬",
    description: "Deep code analysis and security auditing",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "read-only-explorer", quantity: 3 },
      { profileId: "security-auditor", quantity: 2 },
      { profileId: "doc-generator", quantity: 1 },
    ],
    initialPrompt: "You lead a research team. Send explorers to analyze different parts of the codebase, have auditors check for security issues, and produce a consolidated report via the doc generator.",
    rules: { maxConcurrentWorkers: 6, autoRestart: false, requireApproval: true },
  },
  {
    name: "Code Review Pipeline",
    icon: "🔍",
    description: "Multi-reviewer pipeline for thorough PR review",
    orchestratorProfileId: "orchestrator",
    slots: [
      { profileId: "code-reviewer", quantity: 2 },
      { profileId: "security-auditor", quantity: 1 },
      { profileId: "test-writer", quantity: 1 },
    ],
    initialPrompt: "You run a code review pipeline. Send reviewers to examine code quality, have the security auditor check for vulnerabilities, and the test writer suggest missing test cases. Synthesize findings into a unified review.",
    rules: { maxConcurrentWorkers: 4, autoRestart: false, requireApproval: false },
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

