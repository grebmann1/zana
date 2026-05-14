// Module Tool Registry
// Maintains a registry of MCP tools contributed by modules.
// Tools are prefixed as hive_<moduleId>_<toolName>.

const registry = new Map(); // moduleId -> tool[]

function log(msg) { process.stderr.write(`[module-tool-registry] ${msg}\n`); }

/**
 * Register tools from a module.
 * @param {string} moduleId
 * @param {Array<{name: string, description: string, inputSchema: object, moduleId: string, handler?: function}>} tools
 */
function registerModuleTools(moduleId, tools) {
  if (!moduleId || !Array.isArray(tools)) return;
  registry.set(moduleId, tools);
  log(`registered ${tools.length} tool(s) from module "${moduleId}"`);
}

/**
 * Remove all tools for a module.
 * @param {string} moduleId
 */
function unregisterModuleTools(moduleId) {
  if (registry.has(moduleId)) {
    const count = registry.get(moduleId).length;
    registry.delete(moduleId);
    log(`unregistered ${count} tool(s) from module "${moduleId}"`);
  }
}

/**
 * Return all registered module tools (flat array).
 * @returns {Array<{name: string, description: string, inputSchema: object, moduleId: string, handler?: function}>}
 */
function listModuleTools() {
  const all = [];
  for (const tools of registry.values()) {
    all.push(...tools);
  }
  return all;
}

/**
 * Get a specific tool by its prefixed name (e.g. "hive_mymodule_doStuff").
 * @param {string} prefixedName
 * @returns {{name: string, description: string, inputSchema: object, moduleId: string, handler?: function} | null}
 */
function getModuleTool(prefixedName) {
  for (const tools of registry.values()) {
    const found = tools.find((t) => t.name === prefixedName);
    if (found) return found;
  }
  return null;
}

/**
 * Get tools for a specific module.
 * @param {string} moduleId
 * @returns {Array}
 */
function getToolsForModule(moduleId) {
  return registry.get(moduleId) || [];
}

/**
 * Clear the entire registry (used during shutdown).
 */
function clear() {
  registry.clear();
}

module.exports = {
  registerModuleTools,
  unregisterModuleTools,
  listModuleTools,
  getModuleTool,
  getToolsForModule,
  clear,
};
