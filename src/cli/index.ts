import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLocale } from "../core/locale.js";
import { createTranslator, type Locale, type MessageKey, type Translator } from "../i18n/index.js";
import { readLangEnv } from "./_locale.js";
import { dismissCommand } from "./dismiss.js";
import { doctorCommand } from "./doctor.js";
import { initCommand } from "./init.js";
import { itemsCommand } from "./items.js";
import { researchCommand } from "./research.js";
import { reviewCommand } from "./review.js";
import { routineCommand } from "./routine.js";
import { sourceCommand } from "./source.js";
import { triageCommand } from "./triage.js";
import { undismissCommand } from "./undismiss.js";
import { updateCommand } from "./update.js";
import { watchCommand } from "./watch.js";
import { workflowCommand } from "./workflow.js";

export interface Command {
  name: string;
  /**
   * Plain-English one-liner. Retained as the canonical source text and the
   * fallback when no {@link summaryKey} is set; localized output goes through
   * {@link summaryKey} instead (#311).
   */
  summary: string;
  /**
   * i18n key resolving to the localized one-line summary shown in
   * `radar --help`. When present the dispatcher renders `t(summaryKey)`;
   * otherwise it falls back to the plain {@link summary} (#311).
   */
  summaryKey?: MessageKey;
  run: (args: string[]) => Promise<number>;
}

/**
 * Output sinks for the top-level CLI dispatcher. Mirrors the per-command
 * `options.io` seam (e.g. {@link import("./watch.js").WatchIO}) so tests can
 * capture global help / version / error output without spying on `console`.
 */
export interface RunIO {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface RunOptions {
  /** Output sinks; default to `console.log` / `console.error`. */
  io?: RunIO;
  /** Environment bag for `RADAR_LANG`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: inject a translator (and implied locale) directly, bypassing
   * `--lang` / `RADAR_LANG` resolution. When omitted, `run` resolves the
   * locale from the (config-independent) flag/env layers and builds its own
   * translator — the dispatcher reads no config, so `config.locale` does not
   * participate here.
   */
  t?: Translator;
}

const commands: Command[] = [
  initCommand,
  sourceCommand,
  watchCommand,
  researchCommand,
  triageCommand,
  dismissCommand,
  undismissCommand,
  itemsCommand,
  reviewCommand,
  updateCommand,
  doctorCommand,
  workflowCommand,
  routineCommand,
];

// Read the installed package's version at runtime so `radar --version`
// tracks release-please bumps without a parallel source edit. The bin
// ships as dist/cli/index.js with package.json two levels up; the path
// is identical in both npm-installed and local-built layouts because
// tsc preserves src/ → dist/ structure.
const PKG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const VERSION = (JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version: string }).version;

/**
 * Result of splitting the raw argv into the dispatcher preamble + the
 * command and its verbatim argv.
 */
type CommandSplit =
  | {
      kind: "ok";
      /** Global `--lang` value found in the preamble (unvalidated), if any. */
      preamble: { flag: string | undefined };
      /** The command token (or a leading help/version flag), possibly empty. */
      command: string | undefined;
      /** Everything from the command token onward, minus the command itself. */
      commandArgs: string[];
    }
  | { kind: "error"; message: string };

/**
 * Walk the leading args, consuming only a global `--lang <value>` /
 * `--lang=<value>` (the dispatcher's own flag). The first arg that is not such
 * a leading `--lang` is the command token (or a leading `-h`/`-v`); everything
 * after it is forwarded to the subcommand untouched — including any *later*
 * `--lang`, which is the subcommand's to resolve.
 *
 * A dangling `--lang` with no value is a usage error (exit 2), matching
 * {@link import("./_locale.js").LangFlagError}.
 */
function splitAtCommand(argv: string[]): CommandSplit {
  let flag: string | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--lang") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { kind: "error", message: "--lang requires a value (en|ja)" };
      }
      flag = next;
      i++; // consume the value token
      continue;
    }
    if (arg?.startsWith("--lang=")) {
      flag = arg.slice("--lang=".length);
      continue;
    }
    break; // first non-preamble token: the command (or -h/-v)
  }
  const command = argv[i];
  return { kind: "ok", preamble: { flag }, command, commandArgs: argv.slice(i + 1) };
}

function printHelp(t: Translator, log: (message: string) => void): void {
  log(t("cli.help.tagline"));
  log("");
  log(t("cli.help.usage"));
  log("");
  log(t("cli.help.commandsHeading"));
  for (const c of commands) {
    const summary = c.summaryKey ? t(c.summaryKey) : c.summary;
    log(`  ${c.name.padEnd(12)} ${summary}`);
  }
  log("");
  log(t("cli.help.optionsHeading"));
  log(`  -h, --help     ${t("cli.help.optionHelp")}`);
  log(`  -v, --version  ${t("cli.help.optionVersion")}`);
  log(`  --lang <en|ja> ${t("cli.help.optionLang")}`);
}

export async function run(argv: string[], options: RunOptions = {}): Promise<void> {
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));
  const env = options.env ?? process.env;

  // Split argv at the command token: everything *before* it is the dispatcher's
  // own preamble (where a global `--lang` / `-h` / `-v` may sit), everything
  // from the command token onward is forwarded verbatim to the subcommand.
  //
  // The command token is the first arg that is not a `--lang` flag (or its
  // value) and not a leading help/version flag. Splitting this way means a
  // `--lang` placed *after* the command (`radar watch --lang ja run`) is left
  // for the subcommand to resolve its own (config-aware) locale, while the
  // dispatcher still honors a `--lang` placed before the command for its own
  // global help / version / unknown-command output.
  const split = splitAtCommand(argv);
  if (split.kind === "error") {
    error(`radar: ${split.message}`);
    process.exit(2);
  }
  const { preamble, command: first, commandArgs } = split;

  // Resolve the dispatcher's locale from the preamble's `--lang` (+ env). The
  // dispatcher reads no config (config is cwd-dependent and resolved inside each
  // command), so only the flag/env layers feed resolution here.
  const locale: Locale = resolveLocale(
    { flag: preamble.flag, env: readLangEnv(env) },
    { warn: error },
  );
  const t = options.t ?? createTranslator(locale);

  if (!first || first === "-h" || first === "--help" || first === "help") {
    printHelp(t, log);
    return;
  }
  if (first === "-v" || first === "--version" || first === "version") {
    log(VERSION);
    return;
  }
  const command = commands.find((c) => c.name === first);
  if (!command) {
    error(t("cli.error.unknownCommand", { command: first }));
    error(t("cli.error.unknownCommandHint"));
    process.exit(2);
  }
  const code = await command.run(commandArgs);
  if (code !== 0) {
    process.exit(code);
  }
}
