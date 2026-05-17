import { type WatchRunResult, watchRun } from "../core/watcher.js";
import type { Command } from "./index.js";

export interface WatchIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface WatchCommandOptions {
  cwd?: string;
  io?: WatchIO;
  /** Test seam: override the adapter HTTP fetcher. */
  fetch?: typeof globalThis.fetch;
}

interface WatchRunArgs {
  sourceId?: string;
  bootstrap?: boolean;
  help?: boolean;
}

function parseRunArgs(args: string[]): WatchRunArgs {
  const out: WatchRunArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--source") {
      out.sourceId = args[++i];
      continue;
    }
    if (a === "--bootstrap") {
      out.bootstrap = true;
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    throw new Error(`unexpected argument: ${a}`);
  }
  return out;
}

function printWatchHelp(log: (m: string) => void): void {
  log("Usage: radar watch <run> [options]");
  log("");
  log("Subcommands:");
  log("  run [--source <id>] [--bootstrap]   Fetch sources and produce items");
  log("");
  log("Options for run:");
  log("  --source <id>   Limit the run to a single source id");
  log("  --bootstrap     Seed lastSeenIds without emitting items (suppress initial noise)");
}

/**
 * Implementation of `watch run`.
 *
 * Wraps `watchRun` from `core/watcher` with CLI-level concerns (argument
 * parsing, exit code, error sink wiring). The exit code is non-zero when
 * any source errored, so CI pipelines can surface partial failures.
 */
export async function runWatch(args: string[], options: WatchCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  let parsed: WatchRunArgs;
  try {
    parsed = parseRunArgs(args);
  } catch (e) {
    error(`watch run: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printWatchHelp(log);
    return 0;
  }

  let result: WatchRunResult;
  try {
    result = await watchRun({
      cwd,
      sourceId: parsed.sourceId,
      bootstrap: parsed.bootstrap,
      fetch: options.fetch as never,
      log,
      warn,
      error,
    });
  } catch (e) {
    error(`watch run: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const totalDetected = Object.values(result.detected).reduce((acc, list) => acc + list.length, 0);
  if (parsed.bootstrap) {
    log(`watch run: bootstrap complete (${Object.keys(result.states).length} sources)`);
  } else {
    log(
      `watch run: ${totalDetected} new item(s) across ${Object.keys(result.states).length} source(s)`,
    );
  }

  return result.errors.length > 0 ? 1 : 0;
}

export const watchCommand: Command = {
  name: "watch",
  summary: "Fetch sources and produce filtered items (run)",
  run: async (args) => {
    const [sub, ...rest] = args;
    if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
      printWatchHelp((m) => console.log(m));
      return sub ? 0 : 2;
    }
    if (sub === "run") {
      return runWatch(rest);
    }
    console.error(`watch: unknown subcommand '${sub}'`);
    printWatchHelp((m) => console.error(m));
    return 2;
  },
};
