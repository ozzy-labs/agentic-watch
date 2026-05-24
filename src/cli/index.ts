import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLocale } from "../core/locale.js";
import { createTranslator, type Locale, type Translator } from "../i18n/index.js";
import { LangFlagError, parseLangFlag, readLangEnv } from "./_locale.js";
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
  summary: string;
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

function printHelp(t: Translator, log: (message: string) => void): void {
  log(t("cli.help.tagline"));
  log("");
  log(t("cli.help.usage"));
  log("");
  log(t("cli.help.commandsHeading"));
  for (const c of commands) {
    log(`  ${c.name.padEnd(12)} ${c.summary}`);
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

  // Pull `--lang` out of the *whole* argv to resolve the dispatcher's own
  // locale, so it may sit before the subcommand (`radar --lang ja --help`).
  // The dispatcher reads no config (config is cwd-dependent and resolved inside
  // each command), so only the flag/env layers feed resolution here.
  let langFlag: string | undefined;
  let rest: string[];
  try {
    const parsed = parseLangFlag(argv);
    langFlag = parsed.flag;
    rest = parsed.rest;
  } catch (err) {
    if (err instanceof LangFlagError) {
      error(`radar: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const locale: Locale = resolveLocale({ flag: langFlag, env: readLangEnv(env) }, { warn: error });
  const t = options.t ?? createTranslator(locale);

  // `rest` (with `--lang` stripped) decides which top-level branch to take.
  // For subcommand dispatch we forward the *original* argv minus only the
  // command token, so the subcommand still sees any `--lang` the user passed
  // and can run its own config-aware locale resolution.
  const [first] = rest;
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
  const commandIdx = argv.indexOf(first);
  const commandArgs = commandIdx >= 0 ? argv.slice(commandIdx + 1) : rest.slice(1);
  const code = await command.run(commandArgs);
  if (code !== 0) {
    process.exit(code);
  }
}
