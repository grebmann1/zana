"use strict";

import { minimatch } from "minimatch";

// Tools that write to files
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * Extract file path from a tool_input object for file-writing tools.
 */
function extractFilePath(toolName, toolInput) {
  if (!toolInput) return null;
  // Edit, Write, MultiEdit all use file_path
  if (toolInput.file_path) return toolInput.file_path;
  // fallback: check common variants
  if (toolInput.path) return toolInput.path;
  return null;
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Used for matching tool arguments where * should match any characters
 * (unlike minimatch which treats / as a path separator).
 */
function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*");
  return new RegExp("^" + withWildcards + "$");
}

/**
 * Check if a tool name matches a disallowed pattern.
 * Supports exact match and glob patterns like "Bash(rm *)"
 */
function matchesDisallowed(toolName, toolInput, pattern) {
  // Exact tool name match
  if (pattern === toolName) return true;

  // Pattern with arguments, e.g. "Bash(rm *)"
  const parenIdx = pattern.indexOf("(");
  if (parenIdx !== -1 && pattern.endsWith(")")) {
    const patternTool = pattern.slice(0, parenIdx);
    const argGlob = pattern.slice(parenIdx + 1, -1);

    if (patternTool !== toolName) return false;

    // Match against the command/input content using simple glob-to-regex
    // (minimatch won't work here because commands contain / which it treats as path separators)
    const inputStr =
      toolInput?.command || toolInput?.content || toolInput?.input || "";
    return globToRegex(argGlob).test(inputStr);
  }

  // Glob on the tool name itself
  return minimatch(toolName, pattern, { dot: true });
}

/**
 * Compile profile rules into a structured rule set for efficient checking.
 */
export function compileRules(profile) {
  const rules = {
    disallowedTools: profile.disallowedTools || [],
    scopedPaths: (profile.scopedPaths || []).map((p) => p),
    hasScopedPaths: Array.isArray(profile.scopedPaths) && profile.scopedPaths.length > 0,
    canMarkDone: profile.canMarkDone !== false, // default true
  };
  return rules;
}

/**
 * Enforce PreToolUse hook rules.
 *
 * @param {object} hookPayload - The hook event payload with tool_name, tool_input, etc.
 * @param {object} profile - The agent profile with optional disallowedTools, scopedPaths, canMarkDone.
 * @returns {{decision: "allow"} | {decision: "block", reason: string}}
 */
export function enforcePreToolUse(hookPayload, profile) {
  const { tool_name, tool_input } = hookPayload;
  const rules = compileRules(profile);

  // 1. Check disallowed tools
  for (const pattern of rules.disallowedTools) {
    if (matchesDisallowed(tool_name, tool_input, pattern)) {
      return {
        decision: "block",
        reason: `Tool "${tool_name}" is disallowed by pattern "${pattern}"`,
      };
    }
  }

  // 2. Check scoped paths for file-writing tools
  if (rules.hasScopedPaths && FILE_WRITE_TOOLS.has(tool_name)) {
    const filePath = extractFilePath(tool_name, tool_input);
    if (filePath) {
      const allowed = rules.scopedPaths.some((glob) =>
        minimatch(filePath, glob, { dot: true, matchBase: false })
      );
      if (!allowed) {
        return {
          decision: "block",
          reason: `File path "${filePath}" is outside allowed scoped paths: [${rules.scopedPaths.join(", ")}]`,
        };
      }
    }
  }

  // 3. Check canMarkDone restriction
  if (!rules.canMarkDone) {
    if (
      tool_name === "zana_ticket_complete" ||
      (tool_name === "zana_ticket_update_status" &&
        tool_input?.status === "done")
    ) {
      return {
        decision: "block",
        reason: `Agent is not permitted to mark tickets as done (canMarkDone: false)`,
      };
    }
  }

  return { decision: "allow" };
}

