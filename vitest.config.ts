import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.{js,ts}", "packages/*/test/**/*.test.{js,ts}"],
  },
});
