#!/usr/bin/env node
"use strict";

// Copy non-TS asset files that tsc does not emit into dist, so a clean
// `rm -rf dist && build` produces a self-contained artifact.
//
// skill-store.ts resolves BUILT_IN_SKILLS_DIR as path.join(__dirname, "..",
// "skills") — i.e. dist/src/skills at runtime. Built-in instruction skills live
// in src/skills/<id>/{skill.json,*.md} (JSON manifest + markdown body files
// referenced via {{file:...}}). tsc copies neither, so without this step a
// clean build ships ZERO built-in skills and getInstructionsForProfile() never
// surfaces them to spawned agents.

const fs = require("node:fs");
const path = require("node:path");

const pkgRoot = path.resolve(__dirname, "..");

/** Recursively copy files under srcDir into destDir, preserving layout. */
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

// Built-in skills: JSON manifests + their markdown body files.
const isSkillAsset = (name) => name.endsWith(".json") || name.endsWith(".md");
const n = copyTree(
  path.join(pkgRoot, "src", "skills"),
  path.join(pkgRoot, "dist", "src", "skills"),
  isSkillAsset,
);
process.stderr.write(`[copy-assets] built-in skills: copied ${n} file(s) → dist/src/skills\n`);
