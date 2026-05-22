#!/usr/bin/env node
import { run } from "./cli/index.js";
import { maybeRespawnForProxy } from "./cli/respawn.js";

// Self-respawn with `NODE_OPTIONS=--use-env-proxy` when an HTTPS_PROXY /
// HTTP_PROXY env var is present. Runs before `run()` so the spawned child
// process — not the parent — executes the user's command with proxy-aware
// fetch. If we did not respawn (no proxy, opt-out, or already respawned),
// fall through to the normal CLI path.
const decision = maybeRespawnForProxy({
  env: process.env,
  argv: process.argv,
  execPath: process.execPath,
});

if (!decision.respawned) {
  run(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`radar: ${message}`);
    process.exit(1);
  });
}
