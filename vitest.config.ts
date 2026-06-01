import { defineConfig } from "vitest/config";
import * as fs from "node:fs";
import * as path from "node:path";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.{js,ts}", "packages/*/test/**/*.test.{js,ts}"],
  },
  resolve: {
    // Map "./foo.js" relative imports back to ".ts" for source-mode tests.
    // The build emits CommonJS .js files; tests run TS sources directly.
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
  },
  ssr: {
    // Inline @zana-ai/core sources so Vite's plugin can transform their requires.
    // Without this, Node's CJS loader handles internal requires and can't find
    // the `.js`-suffixed paths used in source files.
    noExternal: [/^@zana\//, "@zana-ai/core"],
  },
  plugins: [
    {
      name: "js-to-ts-resolve",
      enforce: "pre",
      async resolveId(source, importer) {
        if (!importer || !source.startsWith(".")) return null;
        const resolved = path.resolve(path.dirname(importer), source);
        // ".js" → ".ts" (rewritten ESM-style imports)
        if (source.endsWith(".js")) {
          const tsCandidate = resolved.slice(0, -3) + ".ts";
          if (fs.existsSync(tsCandidate)) return tsCandidate;
        }
        // Bare relative require ("./foo" or "./foo/bar") with no extension
        if (!path.extname(source)) {
          const tsCandidate = resolved + ".ts";
          if (fs.existsSync(tsCandidate)) return tsCandidate;
          // Or directory with index.ts
          const indexCandidate = path.join(resolved, "index.ts");
          if (fs.existsSync(indexCandidate)) return indexCandidate;
        }
        return null;
      },
    },
  ],
});
