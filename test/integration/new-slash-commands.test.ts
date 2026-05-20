/**
 * new-slash-commands.test.ts — contract tests for the autopilot, team, ticket,
 * schedule, memory, and status slash-command families.
 *
 * Same shape as council-slash-command.test.ts: treat each markdown file as a
 * static contract and verify:
 *   1. Frontmatter parses as YAML.
 *   2. `name` matches the colon-namespaced path implied by the filename.
 *   3. `description` is non-empty and ≤140 chars.
 *   4. `argument-hint` is present iff the command takes args.
 *   5. `allowed-tools` is non-empty, has no wildcards, and every
 *      `mcp__zana__zana_X` token resolves to a real tool registered in
 *      mcp-server.ts or tools/deliberate.ts.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COMMANDS_DIR = path.join(REPO_ROOT, "plugins", "zana", "core", "commands");
const MCP_SERVER_TS = path.join(REPO_ROOT, "packages", "mcp", "src", "mcp-server.ts");
const DELIBERATE_TS = path.join(REPO_ROOT, "packages", "mcp", "src", "tools", "deliberate.ts");

const REGISTERED_TOOLS = (() => {
  const re = /name:\s*"(zana_[a-zA-Z0-9_]+)"/g;
  const set = new Set<string>();
  for (const file of [MCP_SERVER_TS, DELIBERATE_TS]) {
    const src = fs.readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) set.add(m[1]);
    re.lastIndex = 0;
  }
  return set;
})();

function readCommand(file: string): { frontmatter: any; body: string } {
  const raw = fs.readFileSync(path.join(COMMANDS_DIR, file), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing or malformed frontmatter`);
  return { frontmatter: YAML.parse(m[1]), body: m[2] };
}

function expectedName(filename: string): string {
  // autopilot-status.md -> zana:autopilot:status
  // memory.md           -> zana:memory
  // status.md           -> zana:status
  const base = filename.replace(/\.md$/, "");
  return "zana:" + base.replace(/-/g, ":");
}

const NEW_COMMANDS = [
  "autopilot.md",
  "autopilot-status.md",
  "autopilot-list.md",
  "autopilot-cancel.md",
  "team.md",
  "team-status.md",
  "team-list.md",
  "team-stop.md",
  "ticket.md",
  "ticket-list.md",
  "ticket-complete.md",
  "schedule-list.md",
  "schedule-trigger.md",
  "schedule-reload.md",
  "memory.md",
  "status.md",
];

const NO_ARG_COMMANDS = new Set([
  "team-list.md",
  "schedule-list.md",
  "schedule-reload.md",
  "status.md",
]);

describe.each(NEW_COMMANDS)("slash command %s", (file) => {
  it("has well-formed frontmatter contract", () => {
    const { frontmatter } = readCommand(file);

    expect(frontmatter.name, `${file}: name`).toBe(expectedName(file));

    expect(typeof frontmatter.description, `${file}: description type`).toBe("string");
    expect(frontmatter.description.length, `${file}: description non-empty`).toBeGreaterThan(0);
    expect(frontmatter.description.length, `${file}: description ≤140 chars`).toBeLessThanOrEqual(140);

    if (NO_ARG_COMMANDS.has(file)) {
      expect(frontmatter["argument-hint"], `${file}: should omit argument-hint`).toBeUndefined();
    } else {
      expect(typeof frontmatter["argument-hint"], `${file}: argument-hint`).toBe("string");
    }

    expect(typeof frontmatter["allowed-tools"], `${file}: allowed-tools type`).toBe("string");
    expect(frontmatter["allowed-tools"].length, `${file}: allowed-tools non-empty`).toBeGreaterThan(0);
    expect(frontmatter["allowed-tools"], `${file}: no wildcards`).not.toMatch(/\*/);

    const tokens = frontmatter["allowed-tools"].split(/\s+/).filter(Boolean);
    const mcpTools = tokens.filter((t: string) => t.startsWith("mcp__zana__"));
    expect(mcpTools.length, `${file}: lists at least one mcp__zana__ tool`).toBeGreaterThan(0);

    for (const t of mcpTools) {
      const bare = t.replace(/^mcp__zana__/, "");
      expect(
        REGISTERED_TOOLS.has(bare),
        `${file}: ${t} not registered in mcp-server.ts or deliberate.ts`,
      ).toBe(true);
    }
  });
});
