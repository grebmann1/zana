#!/usr/bin/env node
"use strict";

import * as fs from "fs";
import * as path from "path";
import { enforcePreToolUse } from "./hook-enforcer";

function main() {
  const profilePath = process.env.HIVE_PROFILE_PATH;
  if (!profilePath) {
    process.stderr.write("HIVE_PROFILE_PATH env var is required\n");
    process.exit(1);
  }

  // Read profile
  let profile;
  try {
    const raw = fs.readFileSync(path.resolve(profilePath), "utf8");
    profile = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Failed to read profile: ${err.message}\n`);
    process.exit(1);
  }

  // Read hook payload from stdin
  let input = "";
  const stdin = process.stdin;
  stdin.setEncoding("utf8");

  stdin.on("data", (chunk) => {
    input += chunk;
  });

  stdin.on("end", () => {
    let hookPayload;
    try {
      hookPayload = JSON.parse(input);
    } catch (err) {
      process.stderr.write(`Failed to parse stdin JSON: ${err.message}\n`);
      process.exit(1);
    }

    const result = enforcePreToolUse(hookPayload, profile);
    process.stdout.write(JSON.stringify(result) + "\n");

    if (result.decision === "block") {
      process.exit(2);
    }
    process.exit(0);
  });

  stdin.resume();
}

main();
