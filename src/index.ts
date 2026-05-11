#!/usr/bin/env node
import { run } from "./cli/index.js";

run(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`agentic-watch: ${message}`);
  process.exit(1);
});
