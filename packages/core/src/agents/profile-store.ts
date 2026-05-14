import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PROFILES_DIR } from "../config";

export function profilesDir() {
  return PROFILES_DIR;
}

function builtInDir() {
  return path.join(__dirname, "..", "profiles");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function listProfiles() {
  const profiles = [];

  // Built-in profiles
  const builtIn = builtInDir();
  if (fs.existsSync(builtIn)) {
    for (const file of fs.readdirSync(builtIn)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(builtIn, file), "utf8");
        const profile = JSON.parse(raw);
        profile.builtIn = true;
        profiles.push(profile);
      } catch (err) {
        console.warn(`[profile-store] failed to load built-in profile ${file}:`, err.message || err);
      }
    }
  }

  // User profiles
  const userDir = profilesDir();
  if (fs.existsSync(userDir)) {
    for (const file of fs.readdirSync(userDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(userDir, file), "utf8");
        const profile = JSON.parse(raw);
        profile.builtIn = false;
        profiles.push(profile);
      } catch (err) {
        console.warn(`[profile-store] failed to load user profile ${file}:`, err.message || err);
      }
    }
  }

  // Plugin-contributed profiles
  try {
    const pluginLoader = require("../plugins/loader");
    const pluginFiles = pluginLoader.getContributions("profiles");
    for (const filePath of pluginFiles) {
      if (!filePath.endsWith(".json") || !fs.existsSync(filePath)) continue;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const profile = JSON.parse(raw);
        profile.builtIn = false;
        profile._source = "plugin";
        profiles.push(profile);
      } catch (err) {
        console.warn(`[profile-store] failed to load plugin profile ${filePath}:`, err.message || err);
      }
    }
  } catch {
    // plugin-loader not yet initialized — skip
  }

  return profiles;
}

export function getProfile(id) {
  const all = listProfiles();
  return all.find((p) => p.id === id) || null;
}

export function saveProfile(profile) {
  ensureDir(profilesDir());
  if (!profile.id) {
    profile.id = crypto.randomUUID();
  }
  const safeId = profile.id.replace(/[^a-zA-Z0-9\-_]/g, "");
  if (!safeId) throw new Error("Invalid profile ID");
  if (!profile.createdAt) {
    profile.createdAt = new Date().toISOString();
  }
  profile.updatedAt = new Date().toISOString();
  profile.builtIn = false;

  const filePath = path.join(profilesDir(), `${safeId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2) + "\n", "utf8");
  return profile;
}

export function deleteProfile(id) {
  const safeId = id.replace(/[^a-zA-Z0-9\-_]/g, "");
  if (!safeId) throw new Error("Invalid profile ID");
  const filePath = path.join(profilesDir(), `${safeId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

