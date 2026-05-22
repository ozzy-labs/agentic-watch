/**
 * ProgressReporter — UX abstraction for long-running CLI operations.
 *
 * Implements [ADR-0015 Progress Reporting UX](../../docs/adr/0015-progress-reporting-ux.md):
 *
 * - 3-layer model (phase markers / heartbeat spinner / side metrics)
 * - TTY auto-detection with env / flag overrides (`RADAR_NO_PROGRESS=1`,
 *   `--quiet`, `--verbose`)
 * - CI / non-TTY safe degradation: spinner becomes plain text and `\r`
 *   same-line updates are disabled
 * - Zero new runtime dependencies — the spinner frame set
 *   (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) is rotated by an internal `setInterval` and rendered via
 *   `process.stderr.write` + ANSI escape `\x1b[K\r`
 *
 * This is the **base** (#196) — only the interface, the factory, and the
 * default reporter implementation. CLI integration (`research` / `review` /
 * `update`) ships in #197, feed adapter integration in #198. Adapter call
 * sites in `src/agents/*.ts` consume the optional `onProgress` callback
 * defined alongside this module (see `src/agents/types.ts`).
 */

export type ProgressLevel = "quiet" | "normal" | "verbose";

/**
 * Public API surface used by CLI / adapter integrations. Six methods cover
 * the three UX layers from ADR-0015:
 *
 * - `phase`: structured milestone, always rendered (TTY and non-TTY)
 * - `start` / `succeed` / `fail`: spinner lifecycle for a single sub-task.
 *   On TTY, `start` begins same-line spinner animation; `succeed` / `fail`
 *   stop it and emit a single completion line.
 * - `update`: side metrics (page x/N, stdout bytes, ...) — merged into the
 *   spinner row on TTY, suppressed or printed as plain text on non-TTY
 * - `raw`: agent stdout / stderr pass-through. Only printed in `verbose`
 *   level. Default reporter pipes the chunk to `process.stderr` verbatim.
 */
export interface ProgressReporter {
  /** Structured milestone. e.g. `"Spawning claude-code"` */
  phase(name: string, info?: string): void;
  /** Begin a spinner-tracked sub-task. e.g. `"Agent running…"` */
  start(label: string): void;
  /** Update side metrics for the active spinner row. */
  update(metrics: Record<string, string>): void;
  /** Stop the spinner and emit a success line. `duration` is milliseconds. */
  succeed(label: string, duration?: number): void;
  /** Stop the spinner and emit a failure line. */
  fail(label: string, reason: string): void;
  /** Pass-through agent stdout / stderr text (verbose only). */
  raw(text: string): void;
}

export interface CreateProgressReporterOptions {
  /**
   * TTY override. If unspecified, falls back to `process.stderr.isTTY`.
   * Always overridable so tests can pin the value.
   */
  tty?: boolean;
  /** Verbosity. `quiet` = phase markers off; `verbose` = `raw()` enabled. */
  level: ProgressLevel;
  /**
   * Output stream. Defaults to `process.stderr` so progress does not pollute
   * piped stdout (`radar research > out.md`). Tests pass an in-memory stream.
   */
  stream?: NodeJS.WritableStream;
  /**
   * Heartbeat interval in milliseconds (default 1000ms / 1s). Tests can
   * shorten this to verify spinner rotation without burning real time.
   * Negative or zero disables the heartbeat (still renders a static first
   * frame on `start`).
   */
  heartbeatMs?: number;
  /** `Date.now()` override for deterministic elapsed-time rendering. */
  now?: () => number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ANSI_CLEAR_LINE = "\x1b[K";

/**
 * No-op reporter. Used by:
 *
 * - tests that do not care about progress output
 * - `--quiet` / `RADAR_NO_PROGRESS=1` paths (see `createProgressReporter`)
 * - adapter call sites where the caller did not opt into progress
 *
 * All six methods return immediately so wiring a `noopProgressReporter()` to
 * an existing adapter is byte-equivalent to passing `undefined`.
 */
export function noopProgressReporter(): ProgressReporter {
  return {
    phase() {},
    start() {},
    update() {},
    succeed() {},
    fail() {},
    raw() {},
  };
}

/**
 * Construct a `ProgressReporter` honouring the ADR-0015 D2 priority table:
 *
 *   env (`RADAR_NO_PROGRESS=1`) > flag (`level`) > TTY auto-detect
 *
 * - `level: "quiet"` → no-op (callers want zero output)
 * - `RADAR_NO_PROGRESS=1` → no-op (CI escape hatch)
 * - non-TTY + `level: "normal"` → plain text (phase markers + completion
 *   lines, NO spinner animation, NO `\r` overwrite)
 * - TTY + `level: "normal"` → phase markers + spinner + same-line update
 * - `level: "verbose"` → phase markers + spinner (if TTY) + `raw()` pass-
 *   through enabled (regardless of TTY)
 *
 * The reporter is self-contained: callers should not depend on internal
 * state (e.g. the active spinner timer). The contract is the 6-method
 * interface above.
 */
export function createProgressReporter(opts: CreateProgressReporterOptions): ProgressReporter {
  // Env escape hatch (D2 table row 1). Honoured even at `level: "verbose"`
  // — CI environments must be able to opt out unconditionally.
  if (process.env.RADAR_NO_PROGRESS === "1") {
    return noopProgressReporter();
  }
  if (opts.level === "quiet") {
    return noopProgressReporter();
  }

  const tty = opts.tty ?? Boolean(process.stderr.isTTY);
  const stream: NodeJS.WritableStream = opts.stream ?? process.stderr;
  const heartbeatMs = opts.heartbeatMs ?? 1000;
  const now = opts.now ?? Date.now;
  const verbose = opts.level === "verbose";

  // Active spinner state. `null` means no spinner is running.
  let active: {
    label: string;
    startedAt: number;
    frame: number;
    metrics: Record<string, string>;
    timer: NodeJS.Timeout | null;
  } | null = null;

  function renderSpinnerRow(): string {
    if (!active) return "";
    const elapsedSec = Math.max(0, Math.floor((now() - active.startedAt) / 1000));
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const ss = String(elapsedSec % 60).padStart(2, "0");
    const frame = SPINNER_FRAMES[active.frame % SPINNER_FRAMES.length];
    const metricEntries = Object.entries(active.metrics);
    const metricsSuffix =
      metricEntries.length > 0 ? `  ${metricEntries.map(([k, v]) => `${k}: ${v}`).join("  ")}` : "";
    return `${frame} ${active.label} [${mm}:${ss}]${metricsSuffix}`;
  }

  function repaint(): void {
    if (!active) return;
    if (tty) {
      stream.write(`\r${ANSI_CLEAR_LINE}${renderSpinnerRow()}`);
    }
  }

  function clearSpinnerLine(): void {
    if (tty && active) {
      stream.write(`\r${ANSI_CLEAR_LINE}`);
    }
  }

  function stopSpinner(): void {
    if (active?.timer) {
      clearInterval(active.timer);
    }
    active = null;
  }

  return {
    phase(name, info) {
      // Phase markers always claim their own line; clear any active spinner
      // overwrite first so we don't leave a half-painted row in scrollback.
      clearSpinnerLine();
      const suffix = info ? ` (${info})` : "";
      stream.write(`${name}${suffix}\n`);
      // Re-paint the spinner row on the new line so it continues to update.
      repaint();
    },
    start(label) {
      // If a previous spinner was still active, drop it silently — the new
      // start supersedes it (caller bug, but we don't want to crash).
      clearSpinnerLine();
      stopSpinner();
      active = {
        label,
        startedAt: now(),
        frame: 0,
        metrics: {},
        timer: null,
      };
      if (tty) {
        // Paint frame 0 immediately so the user sees something before the
        // first heartbeat tick fires.
        repaint();
        if (heartbeatMs > 0) {
          const timer = setInterval(() => {
            if (!active) return;
            active.frame += 1;
            repaint();
          }, heartbeatMs);
          // Don't keep the event loop alive just for the spinner — if the
          // host process is otherwise idle (e.g. awaiting a child), we still
          // want it to exit when the work is done.
          if (typeof (timer as { unref?: () => void }).unref === "function") {
            (timer as { unref: () => void }).unref();
          }
          active.timer = timer;
        }
      } else {
        // Non-TTY plain-text degrade: one line per state transition, no `\r`.
        stream.write(`${label}\n`);
      }
    },
    update(metrics) {
      if (!active) return;
      // Merge so successive `update` calls only need to pass the changed
      // metric (e.g. page index ticks per fetch).
      active.metrics = { ...active.metrics, ...metrics };
      if (tty) {
        repaint();
      }
      // On non-TTY we intentionally drop tick updates to avoid spamming the
      // log with one line per page. The next phase / succeed / fail line
      // re-states the final metric set.
    },
    succeed(label, duration) {
      const elapsedMs = duration ?? (active ? now() - active.startedAt : 0);
      const formatted = formatDuration(elapsedMs);
      clearSpinnerLine();
      stopSpinner();
      stream.write(`${label} (${formatted})\n`);
    },
    fail(label, reason) {
      clearSpinnerLine();
      stopSpinner();
      stream.write(`${label} — ${reason}\n`);
    },
    raw(text) {
      if (!verbose) return;
      // Clear the spinner row before flushing pass-through so the agent's
      // stdout / stderr line doesn't end up appended to the spinner frame.
      // On non-TTY, the spinner doesn't share a line so clearing is a no-op.
      clearSpinnerLine();
      stream.write(text);
      // If the chunk does not end in a newline, the spinner repaint would
      // overwrite the tail of the chunk. Insert a soft newline before
      // re-rendering so the chunk is preserved verbatim in scrollback.
      if (active && tty && !text.endsWith("\n")) {
        stream.write("\n");
      }
      repaint();
    },
  };
}

/**
 * Format an elapsed-time in milliseconds as either `Nms`, `N.Ns`, or
 * `Nm Ns`. Used by `succeed()` so the completion line carries the actual
 * sub-task duration without the caller having to compute it.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    const seconds = (ms / 1000).toFixed(1);
    return `${seconds}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
