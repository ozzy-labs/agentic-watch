import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locale } from "../../core/locale.js";
import { createTranslator, type Translator } from "../../i18n/index.js";
import { LangFlagError, parseLangFlag, resolveWorkspaceLocale } from "../_locale.js";
import { RESEARCH_BATCH_DEFAULT_MAX_ITEMS } from "../research.js";
import type { SupportedAgent, WorkflowIO } from "./generate-watch.js";
import { SUPPORTED_AGENTS } from "./generate-watch.js";

/**
 * `radar workflow generate combined` (#189 / ADR-0014).
 *
 * Emits a GitHub Actions workflow that chains `radar watch run` -> "skip on
 * no-new-items" guard -> `radar research --batch` in a single job so the
 * detection-to-research delay collapses to one cron tick. The `--max-items`
 * hard cap is rendered as a YAML literal AND re-enforced by the CLI (ADR-0014
 * D3a "二重防御"), so a runaway detection or a hand-edited workflow cannot
 * blow the cap inside one invocation.
 *
 * The four supported `--agent` values map to ADR-0014 D5's API-key-only
 * secrets table (never OAuth). The generator emits the correct `env:` block
 * in both the watch and research steps and prints the secrets the user must
 * register so they do not have to grep the YAML.
 */

/** Default cron expression — daily 00:00 UTC, matching ADR-0004 / watch template. */
const DEFAULT_CRON = "0 0 * * *";

/** Default output path relative to the workspace root (ADR-0014 D6). */
const DEFAULT_OUTPUT = join(".github", "workflows", "feedradar-combined.yaml");

/**
 * Agent-specific `env:` blocks emitted into the generated workflow.
 *
 * Each block sits under `      env:` and is two-space-indented from the
 * `name:` step header (i.e. 10 leading spaces per line). All four agents
 * stay on API-key auth — never OAuth — per ADR-0014 D5.
 *
 * `claude-code` / `codex-cli` / `gemini-cli` also expose `GITHUB_TOKEN`
 * so the github-releases adapter gets the 5000 req/h ceiling instead of 60.
 * `copilot` reuses `secrets.GITHUB_TOKEN` natively (the Copilot CLI
 * authenticates via the GH token).
 */
const AGENT_SECRETS_BLOCKS: Record<SupportedAgent, string> = {
  "claude-code": [
    "          ANTHROPIC_API_KEY: $" + "{{ secrets.ANTHROPIC_API_KEY }}",
    "          GITHUB_TOKEN: $" + "{{ secrets.GITHUB_TOKEN }}",
  ].join("\n"),
  "codex-cli": [
    "          OPENAI_API_KEY: $" + "{{ secrets.OPENAI_API_KEY }}",
    "          GITHUB_TOKEN: $" + "{{ secrets.GITHUB_TOKEN }}",
  ].join("\n"),
  "gemini-cli": [
    "          GEMINI_API_KEY: $" + "{{ secrets.GEMINI_API_KEY }}",
    "          GITHUB_TOKEN: $" + "{{ secrets.GITHUB_TOKEN }}",
  ].join("\n"),
  copilot: ["          GITHUB_TOKEN: $" + "{{ secrets.GITHUB_TOKEN }}"].join("\n"),
};

/**
 * Human-readable list of secrets each agent requires the user to register
 * under Settings -> Secrets and variables -> Actions. Emitted after a
 * successful generation so users do not have to grep the YAML to find what
 * to register.
 */
const AGENT_SECRET_NAMES: Record<SupportedAgent, string[]> = {
  "claude-code": ["ANTHROPIC_API_KEY", "GITHUB_TOKEN (auto-provisioned)"],
  "codex-cli": ["OPENAI_API_KEY", "GITHUB_TOKEN (auto-provisioned)"],
  "gemini-cli": ["GEMINI_API_KEY", "GITHUB_TOKEN (auto-provisioned)"],
  copilot: ["GITHUB_TOKEN (auto-provisioned)"],
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors `resolveTemplatesRoot` in `generate-watch.ts` so both generators
 * find the bundled templates dir under both compiled (`dist/`) and source
 * (`src/`) layouts.
 */
async function resolveTemplatesRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "templates");
}

/**
 * Validate a 5-field POSIX cron expression. Borrowed verbatim from
 * `generate-watch.ts` `isValidCron` so both type generators apply the same
 * shape check (structural only — range validation is GitHub Actions's job).
 */
export function isValidCron(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  const tokenPattern = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/;
  for (const field of fields) {
    if (field.length === 0) return false;
    const tokens = field.split(",");
    for (const token of tokens) {
      if (token.length === 0) return false;
      if (!tokenPattern.test(token)) return false;
    }
  }
  return true;
}

/**
 * Validate that the requested `--output` path lands under
 * `.github/workflows/`. Mirrors `isSafeWorkflowPath` in `generate-watch.ts`.
 */
export function isSafeWorkflowPath(outputPath: string, cwd: string): boolean {
  if (isAbsolute(outputPath)) {
    const allowedDir = resolve(cwd, ".github", "workflows");
    const resolved = resolve(outputPath);
    const rel = relative(allowedDir, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    return /\.(ya?ml)$/i.test(resolved);
  }
  const normalized = normalize(outputPath);
  if (normalized.split(/[\\/]/).includes("..")) return false;
  const required = `${join(".github", "workflows")}/`;
  const unixified = normalized.replace(/\\/g, "/");
  if (!unixified.startsWith(required.replace(/\\/g, "/"))) return false;
  return /\.(ya?ml)$/i.test(unixified);
}

/**
 * Validate `--max-items` as a positive integer. Mirrors `parseMaxItems` in
 * `src/cli/research.ts` so the same input is accepted at both layers (CLI ->
 * workflow YAML -> `radar research --batch`).
 */
export function isValidMaxItems(raw: string): boolean {
  if (!/^[0-9]+$/.test(raw)) return false;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0;
}

/**
 * Render the `--filter-tags` literal as it should appear on the generated
 * `radar research --batch` line.
 *
 * When the user omits the flag, returns an empty string so the resulting
 * line collapses to `radar research --batch --status detected --max-items N
 * --agent <id>` without a stray `--filter-tags`. When present, each tag is
 * trimmed, lower-cased, and deduped (matching the CLI parser) and rendered
 * with a leading space so the template's `--max-items {{maxItems}}{{filterTags}}`
 * concatenation reads naturally.
 */
export function renderFilterTagsLiteral(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return "";
  const tags = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  ];
  if (tags.length === 0) return "";
  return ` --filter-tags ${tags.join(",")}`;
}

/**
 * Render the bundled template by substituting `{{cron}}` / `{{maxItems}}` /
 * `{{filterTags}}` / `{{agent}}` / `{{secretsBlock}}` placeholders.
 *
 * Substitution is a literal `replaceAll` so each placeholder lands
 * atomically in every site it appears (the template intentionally uses
 * `{{secretsBlock}}` twice, in the watch and research steps).
 */
export function renderCombinedTemplate(
  template: string,
  values: {
    cron: string;
    maxItems: number;
    filterTagsLiteral: string;
    agent: SupportedAgent;
    secretsBlock: string;
  },
): string {
  return template
    .replaceAll("{{cron}}", values.cron)
    .replaceAll("{{maxItems}}", String(values.maxItems))
    .replaceAll("{{filterTags}}", values.filterTagsLiteral)
    .replaceAll("{{agent}}", values.agent)
    .replaceAll("{{secretsBlock}}", values.secretsBlock);
}

export interface GenerateCombinedOptions {
  cwd: string;
  watchCron: string;
  output: string;
  agent: SupportedAgent;
  maxItems: number;
  /** Pre-parsed filter-tags allow-list (already lower-cased + deduped). */
  filterTags: string[];
  force: boolean;
  /**
   * UI locale selecting the per-locale template subtree
   * (`<templatesRoot>/<locale>/workflows/`). Defaults to `en` (#315).
   */
  locale?: Locale;
  /** Test seam: override the templates root location. */
  templatesRoot?: string;
  io?: WorkflowIO;
}

export interface GenerateCombinedResult {
  outputPath: string;
  requiredSecrets: string[];
}

/**
 * Core implementation of `radar workflow generate combined`.
 *
 * Validates inputs, reads the bundled `combined.template.yaml.tmpl`,
 * substitutes placeholders, and writes the result. The completion stdout
 * lines tell the user exactly which secrets to register so they do not have
 * to hunt through ADR-0014 D5 by hand. The trailing `warn()` line surfaces
 * the CLI-layer hard-cap double-defense so the user does not assume
 * editing the YAML alone will raise `--max-items`.
 */
export async function generateCombined(
  options: GenerateCombinedOptions,
): Promise<GenerateCombinedResult> {
  const { cwd, watchCron, output, agent, maxItems, filterTags, force } = options;
  const locale: Locale = options.locale ?? "en";
  const t = createTranslator(locale);
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));

  if (!isValidCron(watchCron)) {
    throw new Error(
      `invalid --watch-cron expression '${watchCron}' (expected 5-field POSIX cron, e.g. "0 0 * * *")`,
    );
  }
  if (!isSafeWorkflowPath(output, cwd)) {
    throw new Error(
      `invalid --output '${output}' (must be a relative path under .github/workflows/ ending in .yaml or .yml)`,
    );
  }
  if (!Number.isInteger(maxItems) || maxItems <= 0) {
    throw new Error(`invalid --max-items '${maxItems}' (must be a positive integer)`);
  }

  const templatesRoot = options.templatesRoot ?? (await resolveTemplatesRoot());
  const templatePath = join(templatesRoot, locale, "workflows", "combined.template.yaml.tmpl");
  if (!(await pathExists(templatePath))) {
    throw new Error(`bundled template not found: ${templatePath}`);
  }
  const template = await readFile(templatePath, "utf8");

  // `renderFilterTagsLiteral` accepts the raw CLI string; `generateCombined`
  // accepts a pre-parsed array (so test code can build one without going
  // through CLI parsing). Re-render here so both entrypoints agree on the
  // literal shape.
  const filterTagsLiteral = filterTags.length === 0 ? "" : ` --filter-tags ${filterTags.join(",")}`;

  const rendered = renderCombinedTemplate(template, {
    cron: watchCron,
    maxItems,
    filterTagsLiteral,
    agent,
    secretsBlock: AGENT_SECRETS_BLOCKS[agent],
  });

  const destAbs = isAbsolute(output) ? output : join(cwd, output);
  const destRel = isAbsolute(output) ? relative(cwd, output) : output;

  if ((await pathExists(destAbs)) && !force) {
    throw new Error(`output file already exists: ${destRel} (use --force to overwrite)`);
  }
  if ((await pathExists(destAbs)) && force) {
    warn(t("cli.workflow.generateCombinedOverwriting", { path: destRel }));
  }

  await mkdir(dirname(destAbs), { recursive: true });
  await writeFile(destAbs, rendered, "utf8");

  log(t("cli.workflow.generateCombinedWrote", { path: destRel }));
  log(t("cli.workflow.detailAgent", { agent }));
  log(t("cli.workflow.detailCron", { cron: watchCron }));
  log(t("cli.workflow.detailMaxItems", { maxItems }));
  log(
    t("cli.workflow.detailFilterTags", {
      tags: filterTags.length === 0 ? t("cli.workflow.filterTagsNone") : filterTags.join(","),
    }),
  );
  log("");
  log(t("cli.workflow.requiredSecretsHeading"));
  for (const s of AGENT_SECRET_NAMES[agent]) {
    log(`  ${s}`);
  }
  // Surface the hard-cap double-defense so the user knows editing the YAML
  // alone will not lift the CLI cap (ADR-0014 D3a tail).
  warn(t("cli.workflow.maxItemsCapWarning", { cmd: "workflow generate combined" }));

  return { outputPath: destRel, requiredSecrets: AGENT_SECRET_NAMES[agent] };
}

interface ParsedFlags {
  watchCron: string;
  output: string;
  agent: SupportedAgent;
  maxItems: number;
  filterTags: string[];
  force: boolean;
  help: boolean;
}

/**
 * Parse `workflow generate combined` flags.
 *
 * Throws on missing values, unknown flags, unsupported `--agent` choices,
 * and malformed `--max-items` so the caller can surface validation errors
 * before any IO happens.
 */
export function parseGenerateCombinedArgs(args: string[]): ParsedFlags {
  let watchCron = DEFAULT_CRON;
  let output = DEFAULT_OUTPUT;
  let agent: SupportedAgent = "claude-code";
  let maxItems = RESEARCH_BATCH_DEFAULT_MAX_ITEMS;
  let filterTags: string[] = [];
  let force = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }
    if (a === "--watch-cron") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      watchCron = value;
      continue;
    }
    if (a === "--output") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      output = value;
      continue;
    }
    if (a === "--agent") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      if (!(SUPPORTED_AGENTS as readonly string[]).includes(value)) {
        throw new Error(
          `option --agent expects one of: ${SUPPORTED_AGENTS.join(" | ")}, got '${value}'`,
        );
      }
      agent = value as SupportedAgent;
      continue;
    }
    if (a === "--max-items") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      if (!isValidMaxItems(value)) {
        throw new Error(`option --max-items expects a positive integer, got '${value}'`);
      }
      maxItems = Number.parseInt(value, 10);
      continue;
    }
    if (a === "--filter-tags") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      filterTags = [
        ...new Set(
          value
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0),
        ),
      ];
      continue;
    }
    if (a === "--force" || a === "-f") {
      force = true;
      continue;
    }
    if (a?.startsWith("--") || a?.startsWith("-")) {
      throw new Error(`unknown option: ${a}`);
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }

  return { watchCron, output, agent, maxItems, filterTags, force, help };
}

export function printGenerateCombinedHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.workflow.generateCombinedHelp", { maxItems: RESEARCH_BATCH_DEFAULT_MAX_ITEMS }));
}

/**
 * Entry point invoked by `runWorkflow` (in `src/cli/workflow.ts`) when the
 * user types `radar workflow generate combined`. Translates parsed flags
 * into `generateCombined` arguments and surfaces validation errors with the
 * `workflow generate combined:` prefix to match the rest of the CLI.
 */
export async function runGenerateCombined(
  args: string[],
  io: WorkflowIO = {},
  cwd: string = process.cwd(),
): Promise<number> {
  const log = io.log ?? ((m: string) => console.log(m));
  const error = io.error ?? ((m: string) => console.error(m));

  // Strip `--lang <en|ja>` before the type parser sees argv (mirrors `init`).
  let langFlag: string | undefined;
  let rest: string[];
  try {
    const langState = parseLangFlag(args);
    langFlag = langState.flag;
    rest = langState.rest;
  } catch (e) {
    if (e instanceof LangFlagError) {
      error(`workflow generate combined: ${e.message}`);
      return 2;
    }
    throw e;
  }

  let parsed: ParsedFlags;
  try {
    parsed = parseGenerateCombinedArgs(rest);
  } catch (e) {
    error(`workflow generate combined: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  // Resolve the locale before the help branch so `--help` honors --lang / env /
  // config (the per-type help is now sourced from the i18n catalog, #337).
  const locale = await resolveWorkspaceLocale({ flag: langFlag, cwd, warn: error });
  const t = createTranslator(locale);

  if (parsed.help) {
    printGenerateCombinedHelp(t, log);
    return 0;
  }

  try {
    await generateCombined({
      cwd,
      watchCron: parsed.watchCron,
      output: parsed.output,
      agent: parsed.agent,
      maxItems: parsed.maxItems,
      filterTags: parsed.filterTags,
      force: parsed.force,
      locale,
      io,
    });
    return 0;
  } catch (e) {
    error(`workflow generate combined: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
