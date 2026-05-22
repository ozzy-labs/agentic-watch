import { type ChildProcess, spawn } from "node:child_process";
import { detectProxyUrl, mergeNodeOptions } from "../core/proxy.js";

/**
 * Sentinel env var. Set on the **child** to signal that the current process is
 * already the respawned instance — without this, the bin would respawn itself
 * indefinitely.
 */
export const RESPAWN_SENTINEL = "RADAR_PROXY_RESPAWNED";

/**
 * User opt-out. Setting `RADAR_AUTO_PROXY=0` disables the self-respawn entirely
 * (useful when the user wants to manage `NODE_OPTIONS` themselves, or when the
 * proxy env vars are present but `radar` should bypass them for some reason).
 */
export const OPT_OUT_ENV = "RADAR_AUTO_PROXY";

/**
 * Flag injected into `NODE_OPTIONS`. Tells Node to honor `HTTPS_PROXY` /
 * `HTTP_PROXY` for the built-in `fetch()` / `undici` global agent. Available
 * in Node 22.21+ and 24.5+ (see `engines.node` in package.json).
 */
export const PROXY_FLAG = "--use-env-proxy";

/**
 * Env hint propagated to spawned subprocesses (agent CLI helpers). Mirrors
 * Node's own convention so any tooling that reads the var sees a consistent
 * signal that the user wants proxy-aware HTTP.
 */
export const NODE_USE_ENV_PROXY = "NODE_USE_ENV_PROXY";

export interface RespawnDeps {
  env: NodeJS.ProcessEnv;
  argv: string[];
  execPath: string;
  /** Injected so tests can substitute a mock spawn. */
  spawn?: typeof spawn;
  /** Process-level signal handler registration; injected for tests. */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  /** Final exit invoked once the child completes; injected for tests. */
  exit?: (code: number) => void;
  /** Hook to emit warnings; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

export interface RespawnDecision {
  respawned: boolean;
  reason?: "no-proxy" | "opt-out" | "already-respawned" | "all-proxy-only-warned" | "spawned";
}

/**
 * Decide whether to respawn, and if so, do it.
 *
 * Returns synchronously with `{ respawned: true }` after spawning the child
 * and wiring up signal / exit propagation. Callers MUST treat that as a
 * terminal state and not continue executing the normal CLI path; otherwise
 * both the parent and child would race to write to stdout. The opposite
 * (`respawned: false`) is the green-light to run the CLI inline.
 */
export function maybeRespawnForProxy(deps: RespawnDeps): RespawnDecision {
  const {
    env,
    argv,
    execPath,
    spawn: spawnImpl = spawn,
    onSignal = (sig, h) => process.on(sig, h),
    exit = (code) => process.exit(code),
    warn = (m) => console.warn(m),
  } = deps;

  // Centralized opt-out check. Documented as `RADAR_AUTO_PROXY=0`, but any
  // falsy-looking value ("0" / "false" / "off") disables the feature for
  // user ergonomics. Empty string is treated as "not set" (env shells often
  // collapse unset vars to "").
  const optOut = env[OPT_OUT_ENV];
  if (optOut !== undefined && optOut !== "") {
    if (optOut === "0" || optOut.toLowerCase() === "false" || optOut.toLowerCase() === "off") {
      return { respawned: false, reason: "opt-out" };
    }
  }

  // Sentinel: the child of a previous respawn must not respawn again,
  // otherwise NODE_OPTIONS grows by one token per generation.
  if (env[RESPAWN_SENTINEL] === "1") {
    return { respawned: false, reason: "already-respawned" };
  }

  const detection = detectProxyUrl(env);
  if (!detection) return { respawned: false, reason: "no-proxy" };

  // `--use-env-proxy` ignores `ALL_PROXY`. Warn the user that respawning
  // alone won't make fetch hit the proxy — they need HTTPS_PROXY or HTTP_PROXY.
  // We still respawn so any *downstream* helper that reads ALL_PROXY benefits,
  // but the warning prevents silent failure when the user expected fetch to
  // pick it up.
  if (detection.allProxyOnly) {
    warn(
      "radar: ALL_PROXY is set but HTTPS_PROXY / HTTP_PROXY is not. " +
        "Node's --use-env-proxy ignores ALL_PROXY; set HTTPS_PROXY=<url> " +
        "(and/or HTTP_PROXY) so fetch() can route through the proxy.",
    );
  }

  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_OPTIONS: mergeNodeOptions(env.NODE_OPTIONS, PROXY_FLAG),
    [NODE_USE_ENV_PROXY]: "1",
    [RESPAWN_SENTINEL]: "1",
  };

  // argv[0] = node binary, argv[1] = bin script (radar). We respawn with the
  // same script and forward the user's original arguments untouched.
  const child = spawnImpl(execPath, argv.slice(1), {
    env: nextEnv,
    stdio: "inherit",
  });

  forwardSignals(child, onSignal);

  child.on("exit", (code, signal) => {
    if (signal) {
      // Re-raise the signal on ourselves so our exit status matches the
      // child's (Node maps signal exits to 128 + sig#). Best-effort: if the
      // platform refuses, fall back to a generic non-zero code.
      try {
        process.kill(process.pid, signal);
      } catch {
        exit(1);
      }
      return;
    }
    exit(code ?? 0);
  });

  child.on("error", (err) => {
    warn(`radar: failed to respawn with ${PROXY_FLAG}: ${err.message}`);
    exit(1);
  });

  return { respawned: true, reason: "spawned" };
}

/**
 * Forward terminal signals to the child so Ctrl-C / `kill` propagate cleanly.
 * Without this, the parent would intercept SIGINT and the child (which owns
 * stdin/stdout via `stdio: inherit`) would stay alive until manually killed.
 */
function forwardSignals(
  child: ChildProcess,
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void,
): void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of signals) {
    onSignal(sig, () => {
      // child.kill may throw if the child is already gone; swallow so we
      // don't crash on the very last tick before exit.
      try {
        child.kill(sig);
      } catch {
        // ignore
      }
    });
  }
}
