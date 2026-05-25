import { access } from "node:fs/promises";
import { join } from "node:path";
import { capSeenIds, loadSourceState, saveSourceState } from "../core/state.js";
import { createTranslator, type Translator } from "../i18n/index.js";
import { LangFlagError, parseLangFlag, resolveWorkspaceLocale } from "./_locale.js";
import type { Command } from "./index.js";

/**
 * `radar state prune <source> [--keep N]` (#333).
 *
 * Manually trims an already-bloated `state/<source>.yaml` `lastSeenIds` list
 * down to its newest N ids (FIFO — oldest dropped first). This is the
 * companion to the automatic per-source `maxSeenIds` cap: the cap bounds future
 * growth, while `prune` shrinks state that has *already* accumulated (the
 * motivating observation was 20,958 ids / 1.1MB on an AWS What's New facet
 * sweep, where ~99% of recorded ids never matched the keyword filter).
 *
 * Why FIFO is safe: facet sweeps (ADR-0017) walk publishedAt-descending, so an
 * id old enough to drop out of the trailing window is very unlikely to reappear
 * in a later sweep. The worst case if it does is re-emitting one already-seen
 * item — not data loss.
 *
 * `--older-than <dur>` is intentionally NOT implemented: `lastSeenIds` is a flat
 * `string[]` with no per-id timestamps, so id ages cannot be computed without
 * the per-id metadata schema change deferred to a future ADR (issue #333
 * proposal 4). The flag is recognized only to emit a precise "not supported"
 * message rather than an opaque "unknown option".
 */

/** Sinks for the state command's user-facing output. Tests inject capturing sinks. */
export interface StateIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface StateCommandOptions {
  /** Workspace root (defaults to `process.cwd()` for the real CLI). */
  cwd?: string;
  io?: StateIO;
}

function stateDir(cwd: string): string {
  return join(cwd, "state");
}

function stateFile(cwd: string, sourceId: string): string {
  return join(stateDir(cwd), `${sourceId}.yaml`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface PruneArgs {
  sourceId?: string;
  keep?: string;
  olderThan?: string;
  help?: boolean;
}

/**
 * Parse `state prune` flags.
 *
 * Throws on flags that require a value but receive none, or on unknown flags —
 * the caller maps the thrown message to an exit-code-2 usage error (mirrors the
 * dismiss/source parsers).
 */
function parsePruneArgs(args: string[]): PruneArgs {
  const out: PruneArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--keep") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.keep = value;
      continue;
    }
    if (a === "--older-than") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.olderThan = value;
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (a !== undefined) {
      if (out.sourceId !== undefined) {
        throw new Error(`unexpected extra argument: ${a}`);
      }
      out.sourceId = a;
    }
  }
  return out;
}

function printStateHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.state.help"));
}

/**
 * `radar state prune <source> --keep N`.
 *
 * Loads `state/<source>.yaml`, trims `lastSeenIds` to the newest N entries via
 * the shared {@link capSeenIds} FIFO helper, and writes it back. A no-op trim
 * (list already <= N) still reports the unchanged count so scripted callers get
 * a deterministic summary line.
 */
async function prune(
  rest: string[],
  cwd: string,
  log: (m: string) => void,
  error: (m: string) => void,
  t: Translator,
): Promise<number> {
  let parsed: PruneArgs;
  try {
    parsed = parsePruneArgs(rest);
  } catch (e) {
    error(t("cli.state.parseError", { reason: e instanceof Error ? e.message : String(e) }));
    return 2;
  }
  if (parsed.help) {
    printStateHelp(t, log);
    return 0;
  }
  if (parsed.sourceId === undefined) {
    error(t("cli.state.missingSource"));
    printStateHelp(t, error);
    return 2;
  }

  // `--older-than` cannot be honored against the timestamp-less `lastSeenIds`
  // list (see module docstring). Fail loud with a precise pointer to `--keep`
  // rather than silently ignoring the flag.
  if (parsed.olderThan !== undefined) {
    error(t("cli.state.olderThanUnsupported"));
    return 2;
  }

  if (parsed.keep === undefined) {
    error(t("cli.state.keepRequired"));
    printStateHelp(t, error);
    return 2;
  }
  if (!/^[0-9]+$/.test(parsed.keep)) {
    error(t("cli.state.invalidKeepInteger", { raw: parsed.keep }));
    return 2;
  }
  const keep = Number.parseInt(parsed.keep, 10);
  if (!Number.isFinite(keep) || keep <= 0) {
    error(t("cli.state.invalidKeepPositive", { raw: parsed.keep }));
    return 2;
  }

  const file = stateFile(cwd, parsed.sourceId);
  if (!(await pathExists(file))) {
    error(t("cli.state.sourceNotFound", { sourceId: parsed.sourceId }));
    return 1;
  }

  const state = await loadSourceState(stateDir(cwd), parsed.sourceId);
  const before = state.lastSeenIds.length;
  const trimmed = capSeenIds(state.lastSeenIds, keep);
  const after = trimmed.length;
  const dropped = before - after;

  if (dropped === 0) {
    log(t("cli.state.pruneNoop", { sourceId: parsed.sourceId, count: before, keep }));
    return 0;
  }

  await saveSourceState(stateDir(cwd), { ...state, lastSeenIds: trimmed });
  log(t("cli.state.pruneDone", { sourceId: parsed.sourceId, before, after, dropped }));
  return 0;
}

/**
 * Top-level dispatcher for `radar state <subcommand>`.
 *
 * `prune` is the only subcommand today; the dispatcher shape mirrors
 * `radar source` so adding `gc` / `compact` later (issue #333 proposals 3/4,
 * deferred to ADRs) does not change the command surface.
 */
export async function runState(args: string[], options: StateCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  // Strip `--lang` before the dispatcher inspects argv so the subcommand token
  // is found regardless of `--lang` placement. Each subcommand re-strips its
  // own `--lang` from `rest` (parsePruneArgs rejects unknown `--` flags).
  let langState: ReturnType<typeof parseLangFlag>;
  try {
    langState = parseLangFlag(args);
  } catch (e) {
    if (e instanceof LangFlagError) {
      error(`state: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const locale = await resolveWorkspaceLocale({ flag: langState.flag, cwd, warn: error });
  const t = createTranslator(locale);

  const [sub, ...rest] = langState.rest;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printStateHelp(t, log);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "prune":
      return prune(rest, cwd, log, error, t);
    default:
      error(t("cli.state.unknownSubcommand", { sub }));
      printStateHelp(t, error);
      return 2;
  }
}

export const stateCommand: Command = {
  name: "state",
  summary: "Manage per-source watch state (prune)",
  summaryKey: "cli.summary.state",
  run: (args) => runState(args),
};
