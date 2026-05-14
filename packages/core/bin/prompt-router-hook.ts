#!/usr/bin/env node
// UserPromptSubmit hook — analyzes /zana prompts and injects routing hints.
// stdin: JSON {prompt}. stdout: modified prompt or empty. Exit 0 = continue.

"use strict";

const SIMPLE_KW = /\b(fix|patch|typo|rename|add test|lint|format|bump|update dep|remove unused)\b/i;
const TEAM_KW = /\b(build|implement|redesign|refactor|migrate|overhaul|rewrite|scaffold|new feature|full.?stack)\b/i;
const GOAL_KW = /\b(until tests pass|optimize until|keep trying|retry until|converge|until green|until.*succeeds)\b/i;

function classify(text) {
  const words = text.trim().split(/\s+/).length;
  const hasGoal = GOAL_KW.test(text);
  const hasTeam = TEAM_KW.test(text);
  const hasSimple = SIMPLE_KW.test(text);

  let mode = "single";
  let complexity = "low";

  if (hasGoal) {
    mode = "goal-driven";
    complexity = "high";
  } else if (hasTeam || words > 100) {
    mode = "team";
    complexity = words > 200 ? "high" : "medium";
  } else if (hasSimple || words < 100) {
    mode = "single";
    complexity = words < 30 ? "low" : "medium";
  }

  return { mode, complexity };
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const { prompt } = JSON.parse(input);
    if (!prompt || !prompt.includes("/zana")) {
      process.stdout.write("");
      return;
    }
    const { mode, complexity } = classify(prompt);
    const hint = `[HIVE-HINT: mode=${mode}, complexity=${complexity}]`;
    process.stdout.write(`${hint}\n${prompt}`);
  } catch {
    process.stdout.write("");
  }
});
