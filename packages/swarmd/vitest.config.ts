import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    exclude: [...configDefaults.exclude, "**/.worktrees/**"]
  }
});
