// Tests for the extras scaffold helper: verifies that scaffold() creates the
// expected files with correct content in a temporary directory.
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { scaffold } from "@zana-ai/extras/src/plugins/scaffold.ts";

describe("scaffold", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zana-scaffold-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("creates the target directory when it does not exist", () => {
    const base = makeTmpDir();
    const target = path.join(base, "new-plugin-dir");
    scaffold("my-plugin", target);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("writes plugin.json with the correct id, name, and version", () => {
    const target = makeTmpDir();
    scaffold("my-plugin", target);
    const pluginJson = JSON.parse(
      fs.readFileSync(path.join(target, "plugin.json"), "utf8"),
    );
    expect(pluginJson.id).toBe("my-plugin");
    expect(pluginJson.name).toBe("My Plugin");
    expect(pluginJson.version).toBe("0.1.0");
    expect(pluginJson.main).toBe("index.js");
  });

  it("capitalizes each hyphen-separated word in the display name", () => {
    const target = makeTmpDir();
    scaffold("foo-bar-baz", target);
    const pluginJson = JSON.parse(
      fs.readFileSync(path.join(target, "plugin.json"), "utf8"),
    );
    expect(pluginJson.name).toBe("Foo Bar Baz");
  });

  it("writes package.json with the correct npm package name", () => {
    const target = makeTmpDir();
    scaffold("my-plugin", target);
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(target, "package.json"), "utf8"),
    );
    expect(pkgJson.name).toBe("zana-plugin-my-plugin");
    expect(pkgJson.version).toBe("0.1.0");
    expect(pkgJson.dependencies).toBeUndefined();
  });

  it("writes index.js that references the plugin id and display name", () => {
    const target = makeTmpDir();
    scaffold("hello-world", target);
    const indexJs = fs.readFileSync(path.join(target, "index.js"), "utf8");
    expect(indexJs).toContain(`id: "hello-world"`);
    expect(indexJs).toContain(`name: "Hello World"`);
    expect(indexJs).toContain("activate");
  });

  it("handles a single-word name without hyphens", () => {
    const target = makeTmpDir();
    scaffold("simple", target);
    const pluginJson = JSON.parse(
      fs.readFileSync(path.join(target, "plugin.json"), "utf8"),
    );
    expect(pluginJson.name).toBe("Simple");
  });
});
