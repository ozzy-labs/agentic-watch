import type { Command } from "./index.js";
import { runGenerateCombined } from "./workflow/generate-combined.js";
import { runGenerateWatch } from "./workflow/generate-watch.js";

/**
 * Sinks for the `workflow` command family's user-facing output. Each `<type>`
 * subcommand receives an `IO` object so tests can capture lines without
 * spawning the full CLI; the real CLI binds these to `console.*`.
 */
export interface WorkflowIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface WorkflowCommandOptions {
  /** Workspace root (defaults to `process.cwd()` for the real CLI). */
  cwd?: string;
  io?: WorkflowIO;
}

function printWorkflowHelp(log: (m: string) => void): void {
  log("Usage: radar workflow <subcommand> [...]");
  log("");
  log("Subcommands:");
  log("  generate <type>  Generate a GitHub Actions workflow YAML");
  log("                   Types: watch | combined (more types in future sub-issues)");
  log("");
  log("Run `radar workflow generate <type> --help` for type-specific options.");
}

function printGenerateHelp(log: (m: string) => void): void {
  log("Usage: radar workflow generate <type> [options]");
  log("");
  log("Types:");
  log("  watch     Periodic `radar watch run` (cron + state commit with rebase retry)");
  log("  combined  Periodic `radar watch run` -> auto research --batch with hard cap (ADR-0014)");
  log("");
  log("Run `radar workflow generate <type> --help` for type-specific options.");
}

/**
 * Dispatcher for `radar workflow <subcommand>`.
 *
 * Today the supported subcommands are `generate watch` (#188) and
 * `generate combined` (this issue, #189). Additional `<type>` values
 * (`research` / `review` per #191) will land as new branches in the
 * `generate` switch without changing the surface.
 *
 * See ADR-0014 (workflow generate sub-command) for the full design rationale.
 */
export async function runWorkflow(
  args: string[],
  options: WorkflowCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printWorkflowHelp(log);
    return sub ? 0 : 2;
  }

  if (sub !== "generate") {
    error(`workflow: unknown subcommand '${sub}'`);
    printWorkflowHelp(error);
    return 2;
  }

  const [type, ...typeArgs] = rest;
  if (!type || type === "-h" || type === "--help" || type === "help") {
    printGenerateHelp(log);
    return type ? 0 : 2;
  }

  switch (type) {
    case "watch":
      return runGenerateWatch(typeArgs, options.io ?? {}, cwd);
    case "combined":
      return runGenerateCombined(typeArgs, options.io ?? {}, cwd);
    default:
      error(`workflow generate: unknown type '${type}'`);
      printGenerateHelp(error);
      return 2;
  }
}

export const workflowCommand: Command = {
  name: "workflow",
  summary: "Generate GitHub Actions workflows (generate <type>)",
  run: (args) => runWorkflow(args),
};
