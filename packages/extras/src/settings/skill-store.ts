import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
// Lazy access to @zana/core — avoids load-order issues when this module is
// required during core initialization.
function _core() { return require("@zana/core"); }
function _SKILLS_DIR() { return _core().config.SKILLS_DIR; }
const profileStoreMod: any = new Proxy({}, { get: (_t, p) => _core().agents.profileStore[p] });
const workspaceCtxMod: any = new Proxy({}, { get: (_t, p) => _core().project.workspaceContext[p] });

const ALLOWED_DYNAMIC_COMMANDS = /^(git|node|cat|ls|find|grep|wc|date|pwd|echo|head|tail)\b/;
const SHELL_METACHARACTERS = /&&|\|\||;|\||`|\$\(|>|</;

const BUILT_IN_SKILLS_DIR = path.join(__dirname, "..", "skills");

function ensureDir() {
  fs.mkdirSync(_SKILLS_DIR(), { recursive: true });
}

function loadSkillsFromDir(dir, opts = {}) {
  const skills = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      try {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          const skill = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
          if (opts.builtIn) skill._builtIn = true;
          skills.push(skill);
        } else if (entry.isDirectory()) {
          const skillPath = path.join(dir, entry.name, "skill.json");
          if (fs.existsSync(skillPath)) {
            const skill = JSON.parse(fs.readFileSync(skillPath, "utf8"));
            skill._dirName = entry.name;
            skill._baseDir = dir;
            if (opts.builtIn) skill._builtIn = true;
            skills.push(skill);
          }
        }
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    // directory doesn't exist or unreadable
  }
  return skills;
}

export function listSkills() {
  ensureDir();
  const builtIn = loadSkillsFromDir(BUILT_IN_SKILLS_DIR, { builtIn: true });
  const user = loadSkillsFromDir(_SKILLS_DIR());
  // User skills override built-in if same id
  const idSet = new Set(user.map((s) => s.id));
  const merged = [...user];
  for (const s of builtIn) {
    if (!idSet.has(s.id)) merged.push(s);
  }
  return merged;
}

export function getSkill(id) {
  if (!id) return null;
  ensureDir();
  const sanitized = id.replace(/[^a-zA-Z0-9\-_]/g, "");
  // Try flat file first
  const filePath = path.join(_SKILLS_DIR(), `${sanitized}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {}
  // Try directory format
  const dirPath = path.join(_SKILLS_DIR(), sanitized, "skill.json");
  try {
    const skill = JSON.parse(fs.readFileSync(dirPath, "utf8"));
    skill._dirName = sanitized;
    return skill;
  } catch {}
  // Try matching by _dirName across all skills
  const skills = listSkills();
  return skills.find((s) => s.id === id) || null;
}

const MAX_SUPPORTING_FILES = 10;
const MAX_SUPPORTING_FILE_SIZE = 50 * 1024;

export function saveSkill(skill) {
  ensureDir();
  const now = new Date().toISOString();
  if (!skill.id) {
    skill.id = crypto.randomUUID();
    skill.createdAt = now;
  }
  skill.updatedAt = now;

  if (!skill.name) skill.name = "untitled";
  if (!skill.type) skill.type = "instruction";
  if (skill.enabled === undefined) skill.enabled = true;
  if (skill.global === undefined) skill.global = true;
  if (!skill.description) skill.description = "";

  const supportingFiles = skill.supportingFiles;
  delete skill.supportingFiles;
  delete skill._dirName;

  if (supportingFiles && supportingFiles.length > 0) {
    const dirName = skill.id.replace(/[^a-zA-Z0-9\-_]/g, "");
    const skillDir = path.join(_SKILLS_DIR(), dirName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "skill.json"), JSON.stringify(skill, null, 2) + "\n", "utf8");
    const filesToWrite = supportingFiles.slice(0, MAX_SUPPORTING_FILES);
    for (const file of filesToWrite) {
      if (!file.name || !file.content) continue;
      const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "");
      const content = file.content.slice(0, MAX_SUPPORTING_FILE_SIZE);
      fs.writeFileSync(path.join(skillDir, safeName), content, "utf8");
    }
  } else {
    const filePath = path.join(_SKILLS_DIR(), `${skill.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(skill, null, 2) + "\n", "utf8");
  }
  return skill;
}

export function deleteSkill(id) {
  if (!id) return false;
  const sanitized = id.replace(/[^a-zA-Z0-9\-_]/g, "");
  // Try flat file
  const filePath = path.join(_SKILLS_DIR(), `${sanitized}.json`);
  try { fs.unlinkSync(filePath); return true; } catch {}
  // Try directory
  const dirPath = path.join(_SKILLS_DIR(), sanitized);
  try { fs.rmSync(dirPath, { recursive: true }); return true; } catch {}
  return false;
}

export function toggleSkill(id, enabled) {
  const skill = getSkill(id);
  if (!skill) return false;
  skill.enabled = enabled;
  saveSkill(skill);
  return true;
}

export function resolveSkillContent(skill) {
  let content = skill.content;

  // Resolve {{file:filename}} templates from skill directory
  if (skill._dirName && content) {
    const baseDir = skill._baseDir || _SKILLS_DIR();
    content = content.replace(/\{\{file:([^}]+)\}\}/g, (_, filename) => {
      const safeName = filename.trim().replace(/[^a-zA-Z0-9.\-_]/g, "");
      const filePath = path.join(baseDir, skill._dirName, safeName);
      try {
        const data = fs.readFileSync(filePath, "utf8");
        return data.slice(0, MAX_SUPPORTING_FILE_SIZE);
      } catch {
        return `[file not found: ${safeName}]`;
      }
    });
  }

  if (Array.isArray(skill.dynamicContext) && skill.dynamicContext.length > 0) {
    const cwd = (workspaceCtxMod as any).getWorkspaceRoot();
    let contextBlocks = "";
    for (const { cmd, label } of skill.dynamicContext) {
      if (!ALLOWED_DYNAMIC_COMMANDS.test(cmd)) {
        process.stderr.write(`[skills] Warning: dynamicContext cmd blocked (not in allowlist) for skill "${skill.name}" (${label}): ${cmd}\n`);
        continue;
      }
      if (SHELL_METACHARACTERS.test(cmd)) {
        process.stderr.write(`[skills] Warning: dynamicContext cmd blocked (shell metacharacters) for skill "${skill.name}" (${label}): ${cmd}\n`);
        continue;
      }
      try {
        const output = execSync(cmd, { timeout: 5000, cwd, encoding: "utf8" });
        contextBlocks += `## ${label}\n\`\`\`\n${output}\`\`\`\n\n`;
      } catch (err) {
        process.stderr.write(`[skills] Warning: dynamicContext cmd failed for skill "${skill.name}" (${label}): ${err.message}\n`);
      }
    }
    if (contextBlocks) {
      content = contextBlocks + content;
    }
  }

  if (skill.disableModelInvocation) {
    content += "\n\nCRITICAL: Do NOT invoke any tools or make changes. This skill is information-only. Report findings and stop.";
  }

  return content;
}

export function getEnabledInstructions() {
  const skills = listSkills();
  return skills
    .filter((s) => s.type === "instruction" && s.enabled && s.content)
    .map((s) => `[${s.name}]: ${resolveSkillContent(s)}`);
}

export function getInstructionsForProfile(profileId) {
  const profileStore: any = profileStoreMod;
  const profile = profileStore.getProfile(profileId);
  const skills = listSkills();

  const globalInstructions = skills
    .filter((s) => s.type === "instruction" && s.enabled && s.content && s.global !== false)
    .map((s) => `[${s.name}]: ${resolveSkillContent(s)}`);

  const profileSkillIds = profile?.skillIds || [];
  const profileInstructions = skills
    .filter((s) => s.type === "instruction" && s.enabled && s.content && s.global === false && profileSkillIds.includes(s.id))
    .map((s) => `[${s.name}]: ${resolveSkillContent(s)}`);

  return [...globalInstructions, ...profileInstructions];
}

export function getEnabledToolSkills() {
  const skills = listSkills();
  return skills.filter((s) => s.type === "tool" && s.enabled && s.toolSchema);
}

