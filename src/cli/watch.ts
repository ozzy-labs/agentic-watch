import type { installChromium, ProbeOptions } from "../core/playwright-check.js";
import { createProgressReporter, type ProgressLevel } from "../core/progress.js";
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
  /**
   * Test seam: override the Playwright probe used by the lazy `html-js`
   * pre-check. Threaded straight through to `watchRun` — see watcher.ts.
   */
  playwrightProbeOptions?: ProbeOptions;
  /**
   * Test seam: override `process.env` lookup so the test can toggle
   * `RADAR_AUTO_INSTALL_CHROMIUM=1` deterministically.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: override the Chromium auto-install function. Tests inject a
   * stub that records invocation without spawning the real `npx`.
   */
  installChromiumImpl?: typeof installChromium;
}

interface WatchRunArgs {
  sourceId?: string;
  bootstrap?: boolean;
  /**
   * Backfill mode (ADR-0012 §D4): walk paginated sources (kind: json-api,
   * github-releases, npm-registry) to ingest all available history into
   * items/. Distinct from `--bootstrap` which seeds state without emitting
   * items. Exclusive with `--bootstrap`.
   */
  backfill?: boolean;
  /**
   * Override the per-source `pagination.maxPages` cap for backfill mode.
   * Applies only to the INNER pagination loop — facet sweep (ADR-0017)
   * always walks every facet value regardless of this flag. AWS What's
   * New uses `facets.year` so the recipe's per-facet `maxPages: 30` is
   * the relevant inner cap; pass e.g. `--max-pages 20` to clamp further.
   * Ignored without `--backfill`.
   */
  maxPages?: number;
  /**
   * Progress verbosity level (#198 / ADR-0015 D2). Mutually exclusive:
   * `--verbose` enables stdout pass-through, `--quiet` suppresses the
   * progress reporter entirely (only the legacy 1-line per source log
   * remains). Unspecified leaves the level at `normal` so the reporter
   * picks behaviour from TTY auto-detection + `RADAR_NO_PROGRESS`.
   */
  verbose?: boolean;
  quiet?: boolean;
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
    if (a === "--backfill") {
      out.backfill = true;
      continue;
    }
    if (a === "--max-pages") {
      const raw = args[++i];
      if (raw === undefined) throw new Error("option --max-pages requires a value");
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`option --max-pages expects a positive integer, got '${raw}'`);
      }
      out.maxPages = n;
      continue;
    }
    if (a === "--verbose" || a === "-v") {
      out.verbose = true;
      continue;
    }
    if (a === "--quiet" || a === "-q") {
      out.quiet = true;
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    throw new Error(`unexpected argument: ${a}`);
  }
  // `--bootstrap` (seed lastSeenIds, no items) and `--backfill` (walk history,
  // emit items) are semantically opposite. Reject the combination explicitly
  // so users do not paper over the conflict by hoping for an undocumented
  // merge — ADR-0012 §D4 makes them mutually exclusive.
  if (out.bootstrap && out.backfill) {
    throw new Error("--bootstrap and --backfill are mutually exclusive");
  }
  if (out.maxPages !== undefined && !out.backfill) {
    throw new Error("--max-pages requires --backfill");
  }
  // `--verbose` enables agent stdout pass-through; `--quiet` suppresses
  // every progress line. Allowing both would force an arbitrary winner —
  // reject up front so the user picks one explicitly. Mirrors the
  // research / review / update CLI (#197) which adopted the same rule.
  if (out.verbose && out.quiet) {
    throw new Error("--verbose and --quiet are mutually exclusive");
  }
  return out;
}

function printWatchHelp(log: (m: string) => void): void {
  log("Usage: radar watch <run> [options]");
  log("");
  log("Subcommands:");
  log("  run [--source <id>] [--bootstrap | --backfill [--max-pages N]]");
  log("                  Fetch sources and produce items");
  log("");
  log("Options for run:");
  log("  --source <id>     Limit the run to a single source id");
  log("  --bootstrap       Seed lastSeenIds without emitting items (suppress initial noise)");
  log("  --backfill        Fetch all available history pages and emit items for each.");
  log("                    Supported fully by kind: json-api / github-releases / npm-registry.");
  log("                    Other kinds (rss / html / html-js) only return their current page.");
  log("  --max-pages N     Override pagination.maxPages cap (requires --backfill).");
  log("                    Applies to INNER pagination only — facet sweep");
  log("                    always walks every facet value regardless of this flag.");
  log("  -v, --verbose     Enable progress-reporter raw() pass-through (adapter stdout).");
  log("  -q, --quiet       Suppress the per-source progress reporter (legacy 1-line log");
  log("                    remains). RADAR_NO_PROGRESS=1 has the same effect.");
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

  // Construct the progress reporter once and let the watcher's heuristic
  // decide whether to actually use it. Quiet wins over verbose (parser
  // already rejected the conflict above, but the type signature still
  // needs a single value); `createProgressReporter` itself honours
  // `RADAR_NO_PROGRESS=1` as a higher-priority escape hatch.
  const level: ProgressLevel = parsed.quiet ? "quiet" : parsed.verbose ? "verbose" : "normal";
  const progress = createProgressReporter({ level });

  let result: WatchRunResult;
  try {
    result = await watchRun({
      cwd,
      sourceId: parsed.sourceId,
      bootstrap: parsed.bootstrap,
      backfill: parsed.backfill,
      maxPagesOverride: parsed.maxPages,
      fetch: options.fetch as never,
      log,
      warn,
      error,
      env: options.env,
      playwrightProbeOptions: options.playwrightProbeOptions,
      installChromiumImpl: options.installChromiumImpl,
      progress,
    });
  } catch (e) {
    error(`watch run: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const totalDetected = Object.values(result.detected).reduce((acc, list) => acc + list.length, 0);
  if (parsed.bootstrap) {
    log(`watch run: bootstrap complete (${Object.keys(result.states).length} sources)`);
  } else if (parsed.backfill) {
    log(
      `watch run: backfill complete — ${totalDetected} item(s) ingested across ${Object.keys(result.states).length} source(s)`,
    );
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
