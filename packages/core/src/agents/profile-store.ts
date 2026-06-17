import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PROFILES_DIR } from "@zana-ai/contracts";

export function profilesDir() {
  return PROFILES_DIR;
}

function builtInDir() {
  // Built-in profiles are JSON assets that tsc does not emit; the build's
  // copy-assets step lands them at dist/src/profiles. Resolution must survive
  // three layouts:
  //   - dist build: __dirname=dist/src/agents → ../profiles = dist/src/profiles
  //   - source-mode tests: __dirname=src/agents → ../../profiles = <pkg>/profiles
  //   - the package source profiles/ dir, as a last-resort net if the copy
  //     step was skipped (so a stale/partial dist still finds personas).
  // __dirname is dist/src/agents in a build, src/agents in source-mode tests.
  const candidates = [
    path.join(__dirname, "..", "profiles"),             // dist mode: dist/src/profiles (copy-assets target)
    path.join(__dirname, "..", "..", "profiles"),       // source mode: <pkg>/profiles
    path.join(__dirname, "..", "..", "..", "profiles"), // dist mode last-resort: <pkg>/profiles (source net)
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // Nothing resolved — return the first candidate so callers get a stable path,
  // but the empty-result warning in listProfiles() will fire.
  return candidates[0];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function listProfiles() {
  const profiles = [];

  // Built-in profiles
  const builtIn = builtInDir();
  let builtInCount = 0;
  if (fs.existsSync(builtIn)) {
    for (const file of fs.readdirSync(builtIn)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(builtIn, file), "utf8");
        const profile = JSON.parse(raw);
        profile.builtIn = true;
        profiles.push(profile);
        builtInCount++;
      } catch (err) {
        console.warn(`[profile-store] failed to load built-in profile ${file}:`, err.message || err);
      }
    }
  }
  if (builtInCount === 0) {
    // No built-in personas resolved — every auto-spawn (code-reviewer,
    // architect, …) will fail to find its profile. This is almost always a
    // broken build artifact (copy-assets step skipped). Warn loudly rather
    // than silently degrade.
    console.warn(
      `[profile-store] WARNING: 0 built-in profiles found at ${builtIn}. ` +
      `Auto-spawned reviewers/workers will fail to resolve. ` +
      `Run the core build so scripts/copy-assets.js populates dist/src/profiles.`,
    );
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
    const pluginLoader = require("@zana-ai/extras").plugins.loader;
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

/** Find all profiles with a matching `lens` field. */
export function getProfilesByLens(lens) {
  if (!lens) return [];
  return listProfiles().filter((p) => p && p.lens === lens);
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

