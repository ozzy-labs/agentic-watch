import { stat } from "node:fs/promises";

import type { AgentProgressCallback } from "../agents/types.js";
import {
  createProgressReporter,
  noopProgressReporter,
  type ProgressLevel,
  type ProgressReporter,
} from "../core/progress.js";

/**
 * Shared progress helpers for `radar research` / `review` / `update`.
 *
 * #197 wires `ProgressReporter` (ADR-0015) into the three agent-driven CLIs.
 * The CLIs each follow the same phase-marker sequence (Loaded item / Loaded
 * template / Spawning / Agent running / Agent completed / Frontmatter
 * validated / Status transition), so the boilerplate lives here:
 *
 * - {@link parseProgressFlags} normalises `--verbose` / `--quiet` parsing
 *   (extracting them from `argv` so the per-command `parseArgs` sees a clean
 *   array)
 * - {@link buildReporter} centralises the priority chain `RADAR_NO_PROGRESS=1`
 *   > `--quiet` > `--verbose` > default. The reporter writes to `stderr` so it
 *   never collides with the existing `io.log()` / `io.warn()` / `io.error()`
 *   sinks that tests inject (those still drive stdout-like channels).
 * - {@link buildAgentProgressCallback} adapts the adapter's
 *   {@link AgentProgressCallback} (which receives raw stdout/stderr chunks)
 *   into reporter calls. It tracks cumulative stdout bytes so the spinner row
 *   shows `stdout: 4.2 KB`, and forwards chunks verbatim via `reporter.raw()`
 *   when the reporter is in verbose mode.
 * - {@link pollOutputFileSize} starts a 500ms `fs.stat` poll so the spinner
 *   row can show how big the agent's output file is growing. The agent CLIs
 *   write the report to disk as they go (or atomically at the end); polling
 *   the file size is the only stream-agnostic way to surface "something is
 *   actually happening" because most agent runners only emit chatty stdout
 *   for tool calls, not for the report body itself.
 *
 * Naming convention follows ADR-0015 D4: every phase marker uses the verb-
 * forms documented there (`Loaded …`, `Spawning …`, `Agent running…`,
 * `Agent completed (…)`, `Status: … → …`).
 */

export interface ProgressFlagState {
  /** Argv with `--verbose` / `--quiet` stripped. */
  rest: string[];
  /** Resolved verbosity level. */
  level: ProgressLevel;
  /** Saw `--verbose` flag explicitly. */
  verbose: boolean;
  /** Saw `--quiet` flag explicitly. */
  quiet: boolean;
}

export class ProgressFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgressFlagError";
  }
}

/**
 * Strip `--verbose` / `--quiet` from `argv` and return the resolved
 * {@link ProgressLevel} plus the remaining argv for the command's own parser.
 *
 * Mutually exclusive: passing both raises {@link ProgressFlagError} so the
 * caller can convert it into an exit-code-2 usage error consistent with the
 * existing `parseArgs` style. `RADAR_NO_PROGRESS=1` is honoured at reporter
 * construction time (see {@link buildReporter}); we do not mix env handling
 * into argv parsing because env is global and argv is per-invocation.
 */
export function parseProgressFlags(argv: string[]): ProgressFlagState {
  const rest: string[] = [];
  let verbose = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--quiet") {
      quiet = true;
      continue;
    }
    rest.push(arg);
  }
  if (verbose && quiet) {
    throw new ProgressFlagError("--verbose and --quiet are mutually exclusive");
  }
  let level: ProgressLevel;
  if (quiet) level = "quiet";
  else if (verbose) level = "verbose";
  else level = "normal";
  return { rest, level, verbose, quiet };
}

export interface BuildReporterOptions {
  level: ProgressLevel;
  /** Test-only TTY override. Falls back to `process.stderr.isTTY` at runtime. */
  tty?: boolean;
  /** Test-only output stream override. Defaults to `process.stderr`. */
  stream?: NodeJS.WritableStream;
}

/**
 * Construct a {@link ProgressReporter} for a CLI invocation. Thin wrapper
 * around {@link createProgressReporter} that records the helper's existence
 * for grep-discoverability — production callers route through here so the
 * defaulting logic stays in one place.
 *
 * `level: "quiet"` and `RADAR_NO_PROGRESS=1` both produce a no-op reporter
 * (the env check happens inside `createProgressReporter`); the CLI keeps its
 * pre-existing 1-line `io.log("research: wrote …")` summary as the only
 * surviving signal, satisfying the issue's acceptance criterion 8.
 */
export function buildReporter(opts: BuildReporterOptions): ProgressReporter {
  return createProgressReporter({
    level: opts.level,
    tty: opts.tty,
    stream: opts.stream,
  });
}

const KIB = 1024;
const MIB = KIB * 1024;

/**
 * Render a byte count for the spinner row. Uses binary prefixes (KiB / MiB)
 * but renders them as `KB` / `MB` for readability — the spinner is a UX
 * affordance, not a precise meter, and the ADR-0015 D4 examples show `4.2 KB`
 * without binary-suffix pedantry.
 */
export function formatBytes(n: number): string {
  if (n < KIB) return `${n} B`;
  if (n < MIB) return `${(n / KIB).toFixed(1)} KB`;
  return `${(n / MIB).toFixed(1)} MB`;
}

/**
 * Bridge {@link AgentProgressCallback} (raw stdout / stderr chunks) to a
 * {@link ProgressReporter}.
 *
 * On every chunk:
 * - cumulative stdout byte count is folded into the spinner row via
 *   `reporter.update({ stdout: "<formatted>" })`
 * - `reporter.raw(text)` forwards the chunk verbatim. The reporter swallows
 *   the call unless verbosity is `verbose`, so non-verbose callers pay only
 *   the cost of the bridge function itself (no extra stderr writes).
 *
 * stderr chunks are also passed to `reporter.raw()` so `--verbose` users see
 * agent CLI warnings inline. They don't update the `stdout:` metric (that
 * key is intentionally tied to actual stdout volume so the spinner row stays
 * comparable across runs).
 */
export function buildAgentProgressCallback(reporter: ProgressReporter): AgentProgressCallback {
  let stdoutBytes = 0;
  return (kind, text) => {
    if (kind === "stdout") {
      stdoutBytes += Buffer.byteLength(text, "utf8");
      reporter.update({ stdout: formatBytes(stdoutBytes) });
    }
    reporter.raw(text);
  };
}

export interface OutputSizePollHandle {
  /** Stop the poll loop. Safe to call multiple times. */
  stop: () => void;
}

export interface OutputSizePollOptions {
  /** Path to `fs.stat`. The agent should be writing here. */
  path: string;
  reporter: ProgressReporter;
  /** Poll interval in milliseconds (default 500ms per ADR-0015 D5 / #197). */
  intervalMs?: number;
  /**
   * Metric key on the spinner row. Defaults to `output` so the row reads
   * `output: 4.2 KB`. Tests override for deterministic assertions.
   */
  metricKey?: string;
}

/**
 * Poll the agent's output file with `fs.stat` every 500ms (configurable) and
 * push the latest size onto the spinner row.
 *
 * Why polling instead of `fs.watch`: `fs.watch` is platform-flaky (Linux
 * needs inotify, macOS uses FSEvents, WSL has its own quirks) and the agent
 * may write atomically at the end with no intermediate `change` events. A
 * 500ms `fs.stat` poll is reliable everywhere and the cost (one syscall per
 * tick) is negligible next to the agent CLI spawn.
 *
 * The poll silently ignores `ENOENT` because the agent writes the file part-
 * way through the run; we only start showing sizes once the file exists. Any
 * other stat error is also swallowed (best-effort UX, the reporter must
 * never abort the actual research operation).
 */
export function pollOutputFileSize(opts: OutputSizePollOptions): OutputSizePollHandle {
  const intervalMs = opts.intervalMs ?? 500;
  const metricKey = opts.metricKey ?? "output";
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastReportedSize = -1;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const s = await stat(opts.path);
      if (s.size !== lastReportedSize) {
        lastReportedSize = s.size;
        opts.reporter.update({ [metricKey]: formatBytes(s.size) });
      }
    } catch {
      // ENOENT during the early phase of the agent run, or transient stat
      // failure — silently ignore so the spinner UX never crashes the real
      // operation.
    }
  };
  // First tick on next macrotask so callers can return the handle before the
  // poll begins. setInterval also schedules; we add the immediate call so the
  // spinner picks up an existing file without waiting a full interval.
  const startup = setTimeout(() => {
    if (!stopped) {
      void tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      // Don't keep the event loop alive just for the poll.
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    }
  }, 0);
  if (typeof (startup as { unref?: () => void }).unref === "function") {
    (startup as { unref: () => void }).unref();
  }
  return {
    stop() {
      stopped = true;
      clearTimeout(startup);
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Convenience: return a no-op reporter typed as a {@link ProgressReporter}.
 * Re-exported here so CLI modules don't have to import from two places.
 */
export { noopProgressReporter };
