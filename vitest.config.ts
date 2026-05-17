import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Integration tests (`tests/integration/**`) require real browsers and
    // run only under `pnpm test:integration` (see `vitest.integration.config.ts`).
    exclude: ["node_modules/**", "dist/**", "tests/integration/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/types.ts",
        "src/**/index.ts",
        "src/skills/**",
        "src/claude-skills/**",
        "src/gemini-commands/**",
        "src/templates/**",
      ],
    },
  },
});
