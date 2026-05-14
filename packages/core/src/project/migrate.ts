// Migration from ~/.zana/ to .zana/
// Moves tickets, sprints, and artifacts to the project-local directory

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const GLOBAL_ZANA_DIR = path.join(os.homedir(), ".zana");

const MIGRATE_DIRS = ["tickets", "sprints", "artifacts"];

/**
 * Show what would be migrated without performing any changes.
 *
 * @param {string} workspaceRoot - Absolute path to the project root.
 * @returns {{ files: { source: string, target: string }[], globalDir: string }}
 */
export function dryRun(workspaceRoot) {
  const projectPath = path.join(workspaceRoot, ".zana");
  const files = [];

  for (const dir of MIGRATE_DIRS) {
    const sourceDir = path.join(GLOBAL_ZANA_DIR, dir);
    if (!fs.existsSync(sourceDir)) continue;

    const entries = fs.readdirSync(sourceDir).filter(
      (f) => f.endsWith(".json") && f !== "_index.json"
    );

    for (const entry of entries) {
      files.push({
        source: path.join(sourceDir, entry),
        target: path.join(projectPath, dir, entry),
      });
    }
  }

  return { files, globalDir: GLOBAL_ZANA_DIR };
}

/**
 * Perform migration from ~/.zana/ to project-local .zana/ directory.
 *
 * @param {string} workspaceRoot - Absolute path to the project root.
 * @param {{ dryRun?: boolean, force?: boolean, verbose?: boolean }} [options]
 * @returns {{ copied: number, skipped: number, errors: string[] }}
 */
export function migrate(workspaceRoot, options = {}) {
  const { dryRun: isDryRun = false, force = false, verbose = false } = options;

  const summary = { copied: 0, skipped: 0, errors: [] };

  // 1. Verify ~/.zana/ exists and has data
  if (!fs.existsSync(GLOBAL_ZANA_DIR)) {
    summary.errors.push(`Global zana directory not found: ${GLOBAL_ZANA_DIR}`);
    return summary;
  }

  const hasData = MIGRATE_DIRS.some((dir) => {
    const dirPath = path.join(GLOBAL_ZANA_DIR, dir);
    if (!fs.existsSync(dirPath)) return false;
    const files = fs.readdirSync(dirPath).filter(
      (f) => f.endsWith(".json") && f !== "_index.json"
    );
    return files.length > 0;
  });

  if (!hasData) {
    summary.errors.push("No tickets, sprints, or artifacts found in global directory.");
    return summary;
  }

  // 2. Verify .zana/ exists in workspaceRoot (or create it)
  const { isProjectInitialized, initProjectDir } = require("./init");
  if (!isProjectInitialized(workspaceRoot)) {
    if (isDryRun) {
      if (verbose) {
        console.log(`  [dry-run] Would initialize .zana/ in ${workspaceRoot}`);
      }
    } else {
      initProjectDir(workspaceRoot, { silent: true });
      if (verbose) {
        console.log(`  Initialized .zana/ in ${workspaceRoot}`);
      }
    }
  }

  const projectPath = path.join(workspaceRoot, ".zana");

  // 3. Copy files from global to local
  for (const dir of MIGRATE_DIRS) {
    const sourceDir = path.join(GLOBAL_ZANA_DIR, dir);
    if (!fs.existsSync(sourceDir)) continue;

    const targetDir = path.join(projectPath, dir);

    // Ensure target directory exists
    if (!isDryRun) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const entries = fs.readdirSync(sourceDir).filter(
      (f) => f.endsWith(".json") && f !== "_index.json"
    );

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry);
      const targetPath = path.join(targetDir, entry);

      try {
        // 4. Check if target exists
        if (fs.existsSync(targetPath) && !force) {
          summary.skipped++;
          if (verbose) {
            console.log(`  [skip] ${dir}/${entry} (already exists, use --force to overwrite)`);
          }
          continue;
        }

        if (isDryRun) {
          summary.copied++;
          if (verbose) {
            console.log(`  [dry-run] ${dir}/${entry} → .zana/${dir}/${entry}`);
          }
        } else {
          fs.copyFileSync(sourcePath, targetPath);
          summary.copied++;
          if (verbose) {
            console.log(`  [copy] ${dir}/${entry} → .zana/${dir}/${entry}`);
          }
        }
      } catch (err) {
        summary.errors.push(`Failed to copy ${dir}/${entry}: ${err.message}`);
      }
    }
  }

  // 5. Regenerate indexes (only if we actually copied files)
  if (!isDryRun && summary.copied > 0) {
    try {
      // We need workspace-context to be pointed at this workspace for rebuildIndex to work.
      // Instead, rebuild indexes directly against the target directories.
      rebuildIndexAt(path.join(projectPath, "tickets"), "ticket");
      rebuildIndexAt(path.join(projectPath, "sprints"), "sprint");
      if (verbose) {
        console.log("  [index] Rebuilt _index.json for tickets and sprints");
      }
    } catch (err) {
      summary.errors.push(`Index rebuild failed: ${err.message}`);
    }
  }

  return summary;
}

/**
 * Rebuild the _index.json for a directory of JSON records.
 * Works standalone without requiring workspace-context initialization.
 */
function rebuildIndexAt(dir, type) {
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter(
    (f) => f.endsWith(".json") && f !== "_index.json"
  );
  const index = [];

  for (const f of files) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      index.push({
        id: record.id,
        title: record.title,
        status: record.status,
        priority: record.priority,
        assigneeId: record.assigneeId,
        updatedAt: record.updatedAt,
      });
    } catch {
      // skip malformed files
    }
  }

  index.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  fs.writeFileSync(path.join(dir, "_index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
}

