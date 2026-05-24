import type { Command } from "./index.js";
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

function printRoutineHelp(log: (m: string) => void): void {
  log("Usage: radar routine <subcommand> [...]");
  log("");
  log("Subcommands:");
  log("  generate <type>  Generate a Claude Code Routine YAML (.claude/routines/)");
  log("                   Types: watch | pipeline");
  log("");
  log("Run `radar routine generate <type> --help` for type-specific options.");
}

function printGenerateHelp(log: (m: string) => void): void {
  log("Usage: radar routine generate <type> [options]");
  log("");
  log("Types:");
  log(
    "  watch     Periodic `radar watch run` self-session routine; commits items/state to a claude/* branch (ADR-0020 D5)",
  );
  log(
    "  pipeline  Full watch -> triage -> research -> review self-session routine, one item at a time (ADR-0020 D5)",
  );
  log("");
  log("Run `radar routine generate <type> --help` for type-specific options.");
}

/**
 * Dispatcher for `radar routine <subcommand>`.
 *
 * Parallels `runWorkflow` in `src/cli/workflow.ts` (GitHub Actions side): the
 * `workflow` namespace targets GHA (spawn + API key), while `routine` targets
 * Claude Routines (self-session, no spawn). See ADR-0020 D1 for the namespace
 * split and D5 for the `<type>` roster (`watch` for detection only; `pipeline`
 * for the full watch -> triage -> research -> review self-session chain).
 */
export async function runRoutine(
  args: string[],
  options: RoutineCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printRoutineHelp(log);
    return sub ? 0 : 2;
  }

  if (sub !== "generate") {
    error(`routine: unknown subcommand '${sub}'`);
    printRoutineHelp(error);
    return 2;
  }

  const [type, ...typeArgs] = rest;
  if (!type || type === "-h" || type === "--help" || type === "help") {
    printGenerateHelp(log);
    return type ? 0 : 2;
  }

  switch (type) {
    case "watch":
      return runGenerateWatchRoutine(typeArgs, options.io ?? {}, cwd);
    case "pipeline":
      return runGeneratePipelineRoutine(typeArgs, options.io ?? {}, cwd);
    default:
      error(`routine generate: unknown type '${type}'`);
      printGenerateHelp(error);
      return 2;
  }
}

export const routineCommand: Command = {
  name: "routine",
  summary: "Generate Claude Code Routines (generate <type>)",
  run: (args) => runRoutine(args),
};
