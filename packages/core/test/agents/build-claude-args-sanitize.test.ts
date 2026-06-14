// buildClaudeArgs — argument sanitization (sanitizeArg).
//
// spawner.ts runs --name and --system-prompt values through sanitizeArg(),
// which strips ASCII control characters (\x00-\x1f and \x7f) before they reach
// the spawned `claude` process. This guards against control-char/escape-sequence
// injection into the child's argv. validateProfile() covers tool-name control
// chars by THROWING; this is the separate, silent-stripping path for the
// human-supplied name and system prompt, which had no dedicated coverage.
import { describe, it, expect } from "vitest";

import { buildClaudeArgs } from "@zana-ai/core/src/agents/spawner.ts";

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe("buildClaudeArgs — sanitizeArg on --name / --system-prompt", () => {
  it("strips ASCII control characters from options.name but keeps printable text", () => {
    // NUL, BEL, ESC, and DEL interleaved with printable characters.
    const dirty = "Co\x00d\x07e\x1br\x7f";
    const args = buildClaudeArgs({}, { name: dirty });
    expect(flagValue(args, "--name")).toBe("Coder");
  });

  it("strips control characters from profile.systemPrompt", () => {
    const args = buildClaudeArgs({ systemPrompt: "Be\x00 hel\x1bpful\x7f" });
    expect(flagValue(args, "--system-prompt")).toBe("Be helpful");
  });

  it("preserves non-control unicode (chars above 0x7f) in the name", () => {
    const args = buildClaudeArgs({}, { name: "Cödér-💡" });
    expect(flagValue(args, "--name")).toBe("Cödér-💡");
  });

  it("coerces a non-string name to a string before emitting it", () => {
    // options.name is truthy but not a string — sanitizeArg must String()-coerce.
    const args = buildClaudeArgs({}, { name: 12345 as unknown as string });
    expect(flagValue(args, "--name")).toBe("12345");
  });
});
