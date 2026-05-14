// Watches project state directories for file changes
// Emits IPC events to renderer when data changes externally
// (e.g., agents creating tickets, writing audit logs)

const fs = require('fs');
const path = require('path');

const WATCH_DIRS = {
  tickets: 'project:tickets-changed',
  sprints: 'project:sprints-changed',
  artifacts: 'project:artifacts-changed',
  plans: 'project:plans-changed',
  audit: 'project:audit-changed',
};

const DEBOUNCE_MS = 80;
const RETRY_MS = 1000;

let watchers = new Map();
let debounceTimers = new Map();
let mainWindowRef = null;
let hiveDirRef = null;
let watching = false;

function debounceEmit(channel, mainWindow) {
  if (debounceTimers.has(channel)) clearTimeout(debounceTimers.get(channel));
  debounceTimers.set(
    channel,
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel);
      }
      debounceTimers.delete(channel);
    }, DEBOUNCE_MS)
  );
}

function shouldIgnore(filename) {
  if (!filename) return true;
  if (filename.startsWith('.')) return true;
  if (filename.startsWith('_')) return true;
  return false;
}

function createWatcher(subdir, channel, mainWindow) {
  const dirPath = path.join(hiveDirRef, subdir);

  if (!fs.existsSync(dirPath)) return;

  // Use recursive watching for tickets (directory-per-ticket format)
  const recursive = subdir === 'tickets';

  try {
    const watcher = fs.watch(dirPath, { recursive }, (eventType, filename) => {
      if (shouldIgnore(filename)) return;
      debounceEmit(channel, mainWindow);
    });

    watcher.on('error', (err) => {
      if (err.code === 'ENOENT') return;
      console.error(`[hive-watcher] Error on ${subdir}:`, err.message);
      // Attempt to re-establish watcher after delay
      watcher.close();
      watchers.delete(subdir);
      setTimeout(() => {
        if (watching) {
          createWatcher(subdir, channel, mainWindow);
        }
      }, RETRY_MS);
    });

    watchers.set(subdir, watcher);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[hive-watcher] Failed to watch ${subdir}:`, err.message);
    }
  }
}

function start(hiveDir, mainWindow) {
  if (watching) stop();

  hiveDirRef = hiveDir;
  mainWindowRef = mainWindow;
  watching = true;

  for (const [subdir, channel] of Object.entries(WATCH_DIRS)) {
    createWatcher(subdir, channel, mainWindow);
  }

  process.stderr.write(`[hive-watcher] Watching ${hiveDir}\n`);
}

function stop() {
  watching = false;

  for (const [, watcher] of watchers) {
    try {
      watcher.close();
    } catch (_) {}
  }
  watchers.clear();

  for (const [, timer] of debounceTimers) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  mainWindowRef = null;
  hiveDirRef = null;

  process.stderr.write('[hive-watcher] Stopped\n');
}

function isWatching() {
  return watching;
}

module.exports = { start, stop, isWatching };
