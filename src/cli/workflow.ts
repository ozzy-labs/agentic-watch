import { createTranslator, type Translator } from "../i18n/index.js";
import { parseLangFlag, resolveWorkspaceLocale } from "./_locale.js";
import type { Command } from "./index.js";
import { runGenerateCombined } from "./workflow/generate-combined.js";
import { runGenerateCombinedWithTriage } from "./workflow/generate-combined-with-triage.js";
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

function printWorkflowHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.workflow.help"));
}

function printGenerateHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.workflow.generateHelp"));
}

/**
 * Dispatcher for `radar workflow <subcommand>`.
 *
 * Supported subcommands: `generate watch` (#188), `generate combined`
 * (#189), and `generate combined-with-triage` (#241 / ADR-0018 §W5).
 * Additional `<type>` values (`research` / `review` per #191) will land
 * as new branches in the `generate` switch without changing the surface.
 *
 * See ADR-0014 (workflow generate sub-command) and ADR-0018 (LLM-based
 * triage extension) for the full design rationale.
 */
export async function runWorkflow(
  args: string[],
  options: WorkflowCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  // Resolve the dispatcher's own help locale from any `--lang` in argv (+ env +
  // config). `parseLangFlag` only *reads* the flag here; the full `args` are
  // still forwarded verbatim to the per-type generate subcommands, which run
  // their own `--lang` resolution (#315). A dangling `--lang` is tolerated —
  // the subcommand surfaces the usage error.
  const { flag: langFlag } = ((): { flag: string | undefined } => {
    try {
      return { flag: parseLangFlag(args).flag };
    } catch {
      return { flag: undefined };
    }
  })();
  const locale = await resolveWorkspaceLocale({ flag: langFlag, cwd, warn: error });
  const t = createTranslator(locale);

  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printWorkflowHelp(t, log);
    return sub ? 0 : 2;
  }

  if (sub !== "generate") {
    error(t("cli.workflow.unknownSubcommand", { sub }));
    printWorkflowHelp(t, error);
    return 2;
  }

  const [type, ...typeArgs] = rest;
  if (!type || type === "-h" || type === "--help" || type === "help") {
    printGenerateHelp(t, log);
    return type ? 0 : 2;
  }

  switch (type) {
    case "watch":
      return runGenerateWatch(typeArgs, options.io ?? {}, cwd);
    case "combined":
      return runGenerateCombined(typeArgs, options.io ?? {}, cwd);
    case "combined-with-triage":
      return runGenerateCombinedWithTriage(typeArgs, options.io ?? {}, cwd);
    default:
      error(t("cli.workflow.unknownType", { type }));
      printGenerateHelp(t, error);
      return 2;
  }
}

export const workflowCommand: Command = {
  name: "workflow",
  summary: "Generate GitHub Actions workflows (generate <type>)",
  summaryKey: "cli.summary.workflow",
  run: (args) => runWorkflow(args),
};
