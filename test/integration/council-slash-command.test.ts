/**
 * council-slash-command.test.ts — smoke test for the /zana:council slash
 * command family (T10).
 *
 * Slash commands aren't directly executable in vitest, so we treat their
 * markdown files as static contracts. We verify:
 *   1. The frontmatter is well-formed YAML.
 *   2. The `name:` field matches the expected slash-command path.
 *   3. Every `mcp__zana__zana_deliberation*` tool listed in `allowed-tools`
 *      actually has a corresponding `name: "..."` registration in the MCP
 *      server's deliberate.ts source — i.e. no typos, no orphan references.
 *   4. The body has the sections promised by the design doc.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COMMANDS_DIR = path.join(REPO_ROOT, "plugins", "zana", "core", "commands");
const DELIBERATE_TS = path.join(REPO_ROOT, "packages", "mcp", "src", "tools", "deliberate.ts");

function readCommand(file: string): { frontmatter: any; body: string; raw: string } {
  const full = path.join(COMMANDS_DIR, file);
  const raw = fs.readFileSync(full, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing or malformed frontmatter`);
  const frontmatter = YAML.parse(m[1]);
  return { frontmatter, body: m[2], raw };
}

const DELIBERATE_TS_SRC = fs.readFileSync(DELIBERATE_TS, "utf8");

function mcpToolIsRegistered(tool: string): boolean {
  // tool looks like "mcp__zana__zana_deliberate"; drop the prefix and check
  // for `name: "<bare>"` in the deliberate.ts source.
  const bare = tool.replace(/^mcp__zana__/, "");
  return new RegExp(`name:\\s*"${bare}"`).test(DELIBERATE_TS_SRC);
}

describe("/zana:council slash command", () => {
  it("has well-formed frontmatter with the right name and tools", () => {
    const { frontmatter } = readCommand("council.md");
    expect(frontmatter.name).toBe("zana:council");
    expect(typeof frontmatter.description).toBe("string");
    expect(frontmatter.description.length).toBeGreaterThan(20);
    expect(typeof frontmatter["argument-hint"]).toBe("string");
    expect(typeof frontmatter["allowed-tools"]).toBe("string");

    // Native council fans-out Agents and fetches profiles — no daemon tools in
    // allowed-tools (the body explicitly forbids calling mcp__zana__zana_deliberate
    // from this command; that's the daemon path).
    const tools = frontmatter["allowed-tools"].split(/\s+/).filter(Boolean);
    expect(tools).toContain("Agent");
    expect(tools).toContain("SendMessage");
    expect(tools).toContain("mcp__zana__zana_get_profile");

    // zana_get_profile must be registered in the MCP server.
    const mcpServerSrc = fs.readFileSync(
      path.join(REPO_ROOT, "packages", "mcp", "src", "mcp-server.ts"),
      "utf8",
    );
    expect(/name:\s*"zana_get_profile"/.test(mcpServerSrc)).toBe(true);
  });

  it("body has Defaults / Workflow / Rules / daemon-path sections", () => {
    const { body } = readCommand("council.md");
    expect(body).toMatch(/##\s+Defaults/i);
    expect(body).toMatch(/##\s+Workflow/i);
    expect(body).toMatch(/##\s+Rules/i);
    expect(body).toMatch(/##\s+When to prefer/i);
    // Defaults must mention the three friendly voters.
    expect(body).toMatch(/architect/);
    expect(body).toMatch(/security-reviewer/);
    expect(body).toMatch(/researcher/);
  });
});

describe.each([
  {
    file: "council-status.md",
    name: "zana:council:status",
    expectTools: ["mcp__zana__zana_deliberation_status"],
  },
  {
    file: "council-list.md",
    name: "zana:council:list",
    expectTools: ["mcp__zana__zana_deliberation_list"],
  },
  {
    file: "council-override.md",
    name: "zana:council:override",
    expectTools: [
      "mcp__zana__zana_deliberation_override",
      "mcp__zana__zana_deliberation_status",
    ],
  },
])("subcommand $name", ({ file, name, expectTools }) => {
  it("has the right frontmatter and registered tools", () => {
    const { frontmatter } = readCommand(file);
    expect(frontmatter.name).toBe(name);
    expect(typeof frontmatter.description).toBe("string");
    const tools = String(frontmatter["allowed-tools"]).split(/\s+/).filter(Boolean);
    for (const t of expectTools) {
      expect(tools, `${file}: missing ${t}`).toContain(t);
      expect(mcpToolIsRegistered(t), `${file}: ${t} not registered`).toBe(true);
    }
  });
});
