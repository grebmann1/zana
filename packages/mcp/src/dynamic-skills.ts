// Dynamic tool-skill loader + built-in handlers (currently just `scratchpad`).
//
// Skills with `type: "tool"` declare their own MCP tool schema and a built-in
// handler name. We load them from SKILLS_DIR at server boot and merge them
// into `tools/list`; their handler runs through the dispatcher in
// mcp-server.ts.

import * as fs from "node:fs";
import * as path from "node:path";

function coreConfig(): { SCRATCHPAD_DIR: string; SKILLS_DIR: string } {
  return require("@zana-ai/core").config;
}

export interface ToolSkill {
  skill: any;       // raw skill JSON (carries `handler`, `enabled`, etc.)
  schema: any;      // MCP tool schema published to `tools/list`
}

export function loadToolSkills(): ToolSkill[] {
  const skillsDir = coreConfig().SKILLS_DIR;
  try {
    const files = fs.readdirSync(skillsDir).filter((f: string) => f.endsWith(".json"));
    const out: ToolSkill[] = [];
    for (const f of files) {
      try {
        const skill = JSON.parse(fs.readFileSync(path.join(skillsDir, f), "utf8"));
        if (skill.type === "tool" && skill.enabled && skill.toolSchema) {
          out.push({ skill, schema: skill.toolSchema });
        }
      } catch (err: any) {
        process.stderr.write(`[zana-mcp] failed to load skill ${f}: ${err.message}\n`);
      }
    }
    return out;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      process.stderr.write(`[zana-mcp] failed to read skills dir: ${err.message}\n`);
    }
    return [];
  }
}

const ZANA_ID = process.env.ZANA_ID || "mcp";

function scratchpadPath(): string {
  return path.join(coreConfig().SCRATCHPAD_DIR, `${ZANA_ID}.md`);
}

export function handleScratchpad(args: any) {
  const dir = coreConfig().SCRATCHPAD_DIR;
  const file = scratchpadPath();
  fs.mkdirSync(dir, { recursive: true });
  switch (args.action) {
    case "read":
      try {
        return { content: fs.readFileSync(file, "utf8") };
      } catch {
        return { content: "" };
      }
    case "write":
      fs.writeFileSync(file, args.content || "", "utf8");
      return { ok: true };
    case "append":
      fs.appendFileSync(file, (args.content || "") + "\n", "utf8");
      return { ok: true };
    default:
      return { error: "unknown action, use: read, write, append" };
  }
}
