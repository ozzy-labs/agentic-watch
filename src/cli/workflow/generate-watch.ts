import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locale } from "../../core/locale.js";
import { createTranslator, type Translator } from "../../i18n/index.js";
import { LangFlagError, parseLangFlag, resolveWorkspaceLocale } from "../_locale.js";

/**
 * Sinks for the `workflow generate watch` command's user-facing output.
 *
 * The CLI binds these to `console.*` by default; tests inject capturing
 * sinks so they can assert against printed lines without poking at stdio.
 */
export interface WorkflowIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * Agents supported by `--agent`. The literal list mirrors ADR-0014 D5's
 * auth-policy table: each agent maps to a single repo secret name and the
 * generator writes that name into the rendered workflow's `env:` block.
 *
 * `copilot` is included for completeness, but uses the auto-provisioned
 * `GITHUB_TOKEN` rather than a user-managed secret — see `agentEnvKey` below.
 */
export const SUPPORTED_AGENTS = ["claude-code", "codex-cli", "gemini-cli", "copilot"] as const;
export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];

/**
 * Resolve the directory holding the bundled workflow templates.
 *
 * Mirrors `resolveTemplatesRoot` in `src/cli/init.ts`: the compiled CLI
 * lives at `dist/cli/workflow/generate-watch.js`, so the bundled templates
 * sit at `../../templates` relative to this module. During tests we may be
 * running from source (`src/cli/workflow/generate-watch.ts`), in which case
 * the same relative path lands at `src/templates/`.
 */
async function resolveTemplatesRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled: dist/cli/workflow/generate-watch.js -> dist/templates
  // Source: src/cli/workflow/generate-watch.ts -> src/templates
  const candidate = resolve(here, "..", "..", "templates");
  return candidate;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map an agent identifier to its required workflow secret name (ADR-0014 D5).
 *
 * The generator writes the result into the rendered workflow as both the
 * `env:` key and the `${{ secrets.<NAME> }}` reference, so the user only
 * needs to register a single secret named after the table below.
 *
 * `copilot` uses the auto-provisioned `GITHUB_TOKEN`; no user action needed.
 * The completion message still surfaces this so the user can confirm
 * `permissions: contents: write` is enough (which it is — Copilot CLI rides
 * the `GITHUB_TOKEN` granted to the job).
 */
export function agentEnvKey(agent: SupportedAgent): string {
  switch (agent) {
    case "claude-code":
      return "ANTHROPIC_API_KEY";
    case "codex-cli":
      return "OPENAI_API_KEY";
    case "gemini-cli":
      return "GEMINI_API_KEY";
    case "copilot":
      return "GITHUB_TOKEN";
  }
}

/**
 * Validate a 5-field POSIX cron expression.
 *
 * GitHub Actions accepts the standard 5-field crontab format (minute, hour,
 * day-of-month, month, day-of-week). We do not aim for byte-perfect parity
 * with the upstream cron parser (e.g. `@daily` aliases) — those are
 * actively documented as unsupported by GitHub Actions, so rejecting them
 * here protects the user from generating a workflow that silently never
 * fires.
 *
 * The validator accepts each field as one of:
 *   - `*`
 *   - `<n>` or `<n>-<m>` (with optional `/<step>`)
 *   - `<a>,<b>,...` (comma list, each token validated independently)
 *   - star slash step (every N units, e.g. `0 *_/6 * * *` reading the
 *     underscore as a placeholder for the slash that would close this comment)
 *
 * Range bounds (e.g. month 1-12) are NOT enforced here; GitHub Actions
 * rejects out-of-range expressions on workflow load. Keeping our check
 * structural keeps the dep surface zero (no cron-parser library) without
 * generating workflows that pass our check but fail GitHub's.
 */
export function isValidCron(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  // Structural per-field check: accepts *, n, n-m, with optional /step.
  // Each comma-separated token must independently satisfy the per-token
  // grammar; an empty token (e.g. trailing comma) fails.
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
 * `.github/workflows/` relative to the workspace root.
 *
 * Two attack/footgun classes are blocked:
 *
 *   1. **Traversal:** `../../etc/passwd` or `.github/workflows/../../foo`
 *      — `..` segments anywhere in the relative path push the file out of
 *      the allowed directory.
 *   2. **Absolute paths:** `/etc/foo` — the workflow is meant to live in
 *      the workspace; an absolute path is almost certainly user error or
 *      malicious input.
 *
 * The check operates on the relative form of the resolved path so that
 * `cwd` differences (test temp dirs vs `process.cwd()`) do not affect the
 * verdict. We also require the file to end with `.yaml` or `.yml` so the
 * GitHub Actions loader picks it up.
 */
export function isSafeWorkflowPath(outputPath: string, cwd: string): boolean {
  if (isAbsolute(outputPath)) {
    // Allow absolute paths only if they're inside the workspace's
    // .github/workflows/ directory. This keeps the test seam (mkdtemp
    // workdirs are absolute) usable while still rejecting paths that
    // escape the workspace.
    const allowedDir = resolve(cwd, ".github", "workflows");
    const resolved = resolve(outputPath);
    const rel = relative(allowedDir, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    return /\.(ya?ml)$/i.test(resolved);
  }
  // Reject any `..` segment in the relative path (after normalize, a
  // traversal that escapes the prefix surfaces as `..` at the start).
  const normalized = normalize(outputPath);
  if (normalized.split(/[\\/]/).includes("..")) return false;
  // Must start with `.github/workflows/`.
  const required = `${join(".github", "workflows")}/`;
  // Normalize separator (Windows users may pass backslashes via tests).
  const unixified = normalized.replace(/\\/g, "/");
  if (!unixified.startsWith(required.replace(/\\/g, "/"))) return false;
  return /\.(ya?ml)$/i.test(unixified);
}

/**
 * Render the bundled template by substituting `{{cron}}` / `{{output}}` /
 * `{{agentEnvKey}}` placeholders with the user-supplied values.
 *
 * Substitution is intentionally a literal `replace`, not a templating
 * engine: the placeholders are simple tokens, and we don't want to expand
 * arbitrary GitHub Actions expressions (`${{ ... }}`) that already live in
 * the template body.
 *
 * Exported for unit testing — tests can drive the renderer in isolation
 * without touching the file system.
 */
export function renderWatchTemplate(
  template: string,
  values: { cron: string; agentEnvKey: string },
): string {
  return template
    .replace(/\{\{cron\}\}/g, values.cron)
    .replace(/\{\{agentEnvKey\}\}/g, values.agentEnvKey);
}

export interface GenerateWatchOptions {
  cwd: string;
  cron: string;
  output: string;
  agent: SupportedAgent;
  force: boolean;
  /**
   * UI locale selecting which per-locale template subtree
   * (`<templatesRoot>/<locale>/workflows/`) the generator reads (#315).
   * Defaults to `en`. Only the natural-language copy (step `name:`, comments)
   * differs across locales; cron / secret names / `run:` commands are identical.
   */
  locale?: Locale;
  /** Test seam: override the templates root location. */
  templatesRoot?: string;
  io?: WorkflowIO;
}

export interface GenerateWatchResult {
  /** Relative path (from `cwd`) of the file that was written. */
  outputPath: string;
  /** Name of the GitHub Actions secret the user must register. */
  requiredSecret: string;
}

/**
 * Core implementation of `radar workflow generate watch`.
 *
 * Validates the cron + output path, renders the template with the
 * agent-appropriate secret name, and writes the result. The completion
 * stdout lines (printed via `io.log`) tell the user exactly which secrets
 * to register so they don't have to hunt through ADR-0014 D5 by hand.
 */
export async function generateWatch(options: GenerateWatchOptions): Promise<GenerateWatchResult> {
  const { cwd, cron, output, agent, force } = options;
  const locale: Locale = options.locale ?? "en";
  const t = createTranslator(locale);
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));

  if (!isValidCron(cron)) {
    throw new Error(
      `invalid --cron expression '${cron}' (expected 5-field POSIX cron, e.g. "0 0 * * *")`,
    );
  }
  if (!isSafeWorkflowPath(output, cwd)) {
    throw new Error(
      `invalid --output '${output}' (must be a relative path under .github/workflows/ ending in .yaml or .yml)`,
    );
  }

  const templatesRoot = options.templatesRoot ?? (await resolveTemplatesRoot());
  // The bundled template is stored with a `.yaml.tmpl` extension so that
  // repo-wide yamlfmt (`lefthook-base.yaml` -> `pre-commit.yaml`) does not
  // run on it. yamlfmt parses `{{agentEnvKey}}` as a flow-style YAML mapping
  // key and rewrites it into syntactically valid but semantically broken
  // YAML, destroying the placeholder. `.tmpl` keeps the file out of the
  // **/*.{yaml,yml} glob while still being browseable on GitHub.
  const templatePath = join(templatesRoot, locale, "workflows", "watch.template.yaml.tmpl");
  if (!(await pathExists(templatePath))) {
    throw new Error(`bundled template not found: ${templatePath}`);
  }
  const template = await readFile(templatePath, "utf8");

  const envKey = agentEnvKey(agent);
  const rendered = renderWatchTemplate(template, { cron, agentEnvKey: envKey });

  const destAbs = isAbsolute(output) ? output : join(cwd, output);
  const destRel = isAbsolute(output) ? relative(cwd, output) : output;

  if ((await pathExists(destAbs)) && !force) {
    throw new Error(`output file already exists: ${destRel} (use --force to overwrite)`);
  }
  if ((await pathExists(destAbs)) && force) {
    warn(t("cli.workflow.generateWatchOverwriting", { path: destRel }));
  }

  await mkdir(dirname(destAbs), { recursive: true });
  await writeFile(destAbs, rendered, "utf8");

  log(t("cli.workflow.generateWatchWrote", { path: destRel }));
  log(t("cli.workflow.generateWatchSummary", { cron, agent }));
  log("");
  log(t("cli.workflow.requiredSecretsHeading"));
  if (agent === "copilot") {
    // Copilot CLI rides the auto-provisioned GITHUB_TOKEN — no user action
    // beyond confirming the workflow's `permissions: contents: write`.
    log(t("cli.workflow.secretCopilotToken"));
  } else {
    log(t("cli.workflow.secretAgentKey", { envKey, agent }));
    log(t("cli.workflow.secretGithubTokenAuto"));
  }

  return { outputPath: destRel, requiredSecret: envKey };
}

interface ParsedFlags {
  cron: string;
  output: string;
  agent: SupportedAgent;
  force: boolean;
  help: boolean;
}

/**
 * Parse `workflow generate watch` flags.
 *
 * Throws on flags that require a value but receive none, unknown flags, or
 * unsupported `--agent` choices. Returning a structured object keeps `run`
 * free of argument-parsing branches.
 */
export function parseGenerateWatchArgs(args: string[]): ParsedFlags {
  let cron = "0 0 * * *";
  let output = join(".github", "workflows", "feedradar-watch.yaml");
  let agent: SupportedAgent = "claude-code";
  let force = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }
    if (a === "--cron") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      cron = value;
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
    if (a === "--force" || a === "-f") {
      force = true;
      continue;
    }
    if (a?.startsWith("--") || a?.startsWith("-")) {
      throw new Error(`unknown option: ${a}`);
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }

  return { cron, output, agent, force, help };
}

export function printGenerateWatchHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.workflow.generateWatchHelp"));
}

/**
 * Entry point invoked by `runWorkflow` (in `src/cli/workflow.ts`) when the
 * user types `radar workflow generate watch`. Translates parsed flags into
 * `generateWatch` arguments and surfaces validation errors with the
 * `workflow generate watch:` prefix to match the rest of the CLI.
 */
export async function runGenerateWatch(
  args: string[],
  io: WorkflowIO = {},
  cwd: string = process.cwd(),
): Promise<number> {
  const log = io.log ?? ((m: string) => console.log(m));
  const error = io.error ?? ((m: string) => console.error(m));

  // Strip `--lang <en|ja>` before the type parser sees argv (mirrors `init`),
  // then resolve the effective locale from --lang > RADAR_LANG > config.locale.
  let langFlag: string | undefined;
  let rest: string[];
  try {
    const langState = parseLangFlag(args);
    langFlag = langState.flag;
    rest = langState.rest;
  } catch (e) {
    if (e instanceof LangFlagError) {
      error(`workflow generate watch: ${e.message}`);
      return 2;
    }
    throw e;
  }

  let parsed: ParsedFlags;
  try {
    parsed = parseGenerateWatchArgs(rest);
  } catch (e) {
    error(`workflow generate watch: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  // Resolve the locale before the help branch so `--help` honors --lang / env /
  // config (the per-type help is now sourced from the i18n catalog, #337).
  const locale = await resolveWorkspaceLocale({ flag: langFlag, cwd, warn: error });
  const t = createTranslator(locale);

  if (parsed.help) {
    printGenerateWatchHelp(t, log);
    return 0;
  }

  try {
    await generateWatch({
      cwd,
      cron: parsed.cron,
      output: parsed.output,
      agent: parsed.agent,
      force: parsed.force,
      locale,
      io,
    });
    return 0;
  } catch (e) {
    error(`workflow generate watch: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
