import { createTranslator, type Translator } from "../i18n/index.js";
import { parseLangFlag, resolveWorkspaceLocale } from "./_locale.js";
import type { Command } from "./index.js";
import { runFireRoutine } from "./routine/fire.js";
import { runGeneratePipelineRoutine } from "./routine/generate-pipeline.js";
import { runGenerateWatchRoutine } from "./routine/generate-watch.js";

/**
 * Sinks for the `routine` command family's user-facing output. Each `<type>`
 * subcommand receives an `IO` object so tests can capture lines without
 * spawning the full CLI; the real CLI binds these to `console.*`.
 */
export interface RoutineIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface RoutineCommandOptions {
  /** Workspace root (defaults to `process.cwd()` for the real CLI). */
  cwd?: string;
  io?: RoutineIO;
}

function printRoutineHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.routine.help"));
}

function printGenerateHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.routine.generateHelp"));
}

/**
 * Dispatcher for `radar routine <subcommand>`.
 *
 * Parallels `runWorkflow` in `src/cli/workflow.ts` (GitHub Actions side): the
 * `workflow` namespace targets GHA (spawn + API key), while `routine` targets
 * Claude Routines (self-session, no spawn). See ADR-0020 D1 for the namespace
 * split and D5 for the `<type>` roster (`watch` for detection only; `pipeline`
 * for the full watch -> triage -> research -> review self-session chain).
 *
 * Subcommands: `generate <type>` emits the source-of-truth YAML; `fire
 * <trig_id>` triggers an already-registered routine from the outside via the
 * `/fire` API (ADR-0020 §「外部からの起動」).
 */
export async function runRoutine(
  args: string[],
  options: RoutineCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  // Resolve the dispatcher's own help locale from any `--lang` in argv (+ env +
  // config). `parseLangFlag` only *reads* the flag; the full `args` are still
  // forwarded verbatim to the per-type generate subcommands, which run their
  // own `--lang` resolution (#315).
  const langFlag = ((): string | undefined => {
    try {
      return parseLangFlag(args).flag;
    } catch {
      return undefined;
    }
  })();
  const locale = await resolveWorkspaceLocale({ flag: langFlag, cwd, warn: error });
  const t = createTranslator(locale);

  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printRoutineHelp(t, log);
    return sub ? 0 : 2;
  }

  if (sub === "fire") {
    return runFireRoutine(rest, options.io ?? {}, process.env, undefined, cwd);
  }

  if (sub !== "generate") {
    error(`routine: unknown subcommand '${sub}'`);
    printRoutineHelp(t, error);
    return 2;
  }

  const [type, ...typeArgs] = rest;
  if (!type || type === "-h" || type === "--help" || type === "help") {
    printGenerateHelp(t, log);
    return type ? 0 : 2;
  }

  switch (type) {
    case "watch":
      return runGenerateWatchRoutine(typeArgs, options.io ?? {}, cwd);
    case "pipeline":
      return runGeneratePipelineRoutine(typeArgs, options.io ?? {}, cwd);
    default:
      error(`routine generate: unknown type '${type}'`);
      printGenerateHelp(t, error);
      return 2;
  }
}

export const routineCommand: Command = {
  name: "routine",
  summary: "Manage Claude Code Routines (generate <type> / fire <trig_id>)",
  summaryKey: "cli.summary.routine",
  run: (args) => runRoutine(args),
};
