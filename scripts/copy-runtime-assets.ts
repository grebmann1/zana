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
  const distModulesRoot = path.join(coreRoot, "dist", "modules");

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
        if (entry.name.endsWith(".json") || entry.name.endsWith(".sh")) {
          copyFile(srcPath, dstPath);
        }
      }
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
  path.join(root, "packages", "mcp", "dist", "bin", "zana-mcp-server.js"),
  path.join(root, "packages", "mcp", "dist", "bin", "setup.js"),
].forEach(chmodExecutableIfExists);
