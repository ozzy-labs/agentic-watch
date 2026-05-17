import { defineConfig } from "vitest/config";

/**
 * Integration test runner config.
 *
 * Integration tests live under `tests/integration/**` and are excluded from
 * the default `pnpm test` run (`vitest.config.ts`) because they require
 * external setup the unit suite avoids — currently a Playwright Chromium
 * install for the `kind: html-js` adapter (ADR-0010). CI invokes this config
 * via `pnpm test:integration` in a separate job that runs
 * `npx playwright install --with-deps chromium` first.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    // Integration tests spin up real browsers / network — give them more
    // headroom than the unit suite's defaults.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
