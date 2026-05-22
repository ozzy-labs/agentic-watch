import type { Command } from "./index.js";
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
  log("                   Types: watch (more types in future sub-issues)");
  log("");
  log("Run `radar workflow generate <type> --help` for type-specific options.");
}

function printGenerateHelp(log: (m: string) => void): void {
  log("Usage: radar workflow generate <type> [options]");
  log("");
  log("Types:");
  log("  watch     Periodic `radar watch run` (cron + state commit with rebase retry)");
  log("");
  log("Run `radar workflow generate <type> --help` for type-specific options.");
}

/**
 * Dispatcher for `radar workflow <subcommand>`.
 *
 * Today the only subcommand is `generate <type>`, and the only supported
 * `<type>` is `watch` (this issue, #188). The dispatcher is structured to
 * accept additional types (`combined` per #189, plus `research` / `review`
 * per #191) without changing the surface — each lands as a new branch in
 * the `generate` switch and the help table grows.
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
