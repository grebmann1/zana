#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyIfExists(src, dst) {
  if (fs.existsSync(src)) copyFile(src, dst);
}

function chmodExecutableIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;
  const mode = fs.statSync(filePath).mode;
  // Add executable bits for user/group/other, preserve existing mode bits.
  fs.chmodSync(filePath, mode | 0o111);
}

function copyCoreAssets() {
  const coreRoot = path.join(root, "packages", "core");
  const modulesRoot = path.join(coreRoot, "modules");
  // The module loader resolves MODULES_DIR as `path.resolve(__dirname, "..", "modules")`,
  // and __dirname after build is packages/core/dist/src/modules — so the runtime
  // discovery directory is packages/core/dist/src/modules.
  const distModulesRoot = path.join(coreRoot, "dist", "src", "modules");

  if (fs.existsSync(modulesRoot)) {
    const stack = [modulesRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      const rel = path.relative(modulesRoot, current);
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const srcPath = path.join(current, entry.name);
        const dstPath = path.join(distModulesRoot, rel, entry.name);
        if (entry.isDirectory()) {
          stack.push(srcPath);
          continue;
        }
        if (
          entry.name.endsWith(".json") ||
          entry.name.endsWith(".sh") ||
          entry.name.endsWith(".js")
        ) {
          copyFile(srcPath, dstPath);
        }
      }
    }
  }

  // Copy built-in agent profiles. profile-store resolves built-ins as
  // `path.join(__dirname, "..", "profiles")`, where __dirname after build is
  // packages/core/dist/src/agents — so the runtime built-in dir is
  // packages/core/dist/src/profiles.
  const profilesRoot = path.join(coreRoot, "profiles");
  const distProfilesRoot = path.join(coreRoot, "dist", "src", "profiles");
  if (fs.existsSync(profilesRoot)) {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      copyFile(
        path.join(profilesRoot, entry.name),
        path.join(distProfilesRoot, entry.name),
      );
    }
  }

  const serverRoot = path.join(root, "packages", "server");
  copyIfExists(
    path.join(serverRoot, "src", "hooks", "wrapper.sh"),
    path.join(serverRoot, "dist", "src", "hooks", "wrapper.sh"),
  );
}

copyCoreAssets();

// Ensure Volta can execute installed CLIs directly from dist outputs.
[
  path.join(root, "dist", "bin", "zana.js"),
  path.join(root, "packages", "core", "dist", "bin", "daemon.js"),
  path.join(root, "packages", "core", "dist", "bin", "statusline.js"),
  path.join(root, "packages", "mcp", "dist", "bin", "zana-mcp-server.js"),
  path.join(root, "packages", "mcp", "dist", "bin", "setup.js"),
].forEach(chmodExecutableIfExists);
