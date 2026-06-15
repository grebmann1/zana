#!/usr/bin/env node
"use strict";

// Copy non-TS asset files that tsc does not emit into dist, so a clean
// `rm -rf dist && build` produces a self-contained artifact.
//
// Two asset classes resolve at runtime from dist/src/ (see profile-store.ts
// builtInDir() and modules/loader.ts MODULES_DIR):
//   - profiles/*.json          → built-in agent personas (pure JSON assets)
//   - modules/<id>/*           → each module ships a COMMITTED index.js entry
//                                (manifest.main) plus a module.json manifest.
//                                Neither is tsc output — the module subtree is
//                                hand-written JS+JSON that tsc does not touch.
//                                The loader does require(<id>/index.js), so the
//                                whole subtree must be copied, not just the JSON.
//
// Without this step a clean `rm -rf dist && build` silently produces an
// artifact with ZERO built-in profiles (auto-spawned reviewers fail to resolve)
// and ZERO loadable modules (require throws MODULE_NOT_FOUND for each <id>).

const fs = require("node:fs");
const path = require("node:path");

const pkgRoot = path.resolve(__dirname, "..");

/**
 * Recursively copy files under srcDir into destDir, preserving layout.
 * `match(filename)` decides which files to copy.
 */
function copyTree(srcDir, destDir, match) {
  if (!fs.existsSync(srcDir)) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(srcPath, destPath, match);
    } else if (entry.isFile() && match(entry.name)) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      copied++;
    }
  }
  return copied;
}

// dist/src mirrors the src/ layout tsc emits, and builtInDir()/MODULES_DIR
// resolve relative to __dirname inside dist/src/** — so assets must land under
// dist/src/profiles and dist/src/modules.
//   - profiles: JSON only.
//   - modules: the committed index.js entry + module.json manifest. tsc DOES
//     emit dist/src/modules/{loader,bridge,...}.js from the top-level *.ts;
//     copying *.js here only adds the per-module entry files (the top-level
//     .ts have no sibling committed .js, so nothing is clobbered).
const isJson = (name) => name.endsWith(".json");
const isModuleAsset = (name) => name.endsWith(".json") || name.endsWith(".js");
const targets = [
  { src: path.join(pkgRoot, "profiles"), dest: path.join(pkgRoot, "dist", "src", "profiles"), label: "profiles", match: isJson },
  { src: path.join(pkgRoot, "modules"), dest: path.join(pkgRoot, "dist", "src", "modules"), label: "module assets", match: isModuleAsset },
];

let total = 0;
for (const t of targets) {
  const n = copyTree(t.src, t.dest, t.match);
  total += n;
  process.stderr.write(`[copy-assets] ${t.label}: copied ${n} file(s) → ${path.relative(pkgRoot, t.dest)}\n`);
}

if (total === 0) {
  process.stderr.write("[copy-assets] WARNING: copied 0 asset files — check that profiles/ and modules/ exist\n");
}
