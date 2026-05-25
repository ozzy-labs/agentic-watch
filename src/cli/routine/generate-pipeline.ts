import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locale } from "../../core/locale.js";
import { createTranslator, type Translator } from "../../i18n/index.js";
import { LangFlagError, parseLangFlag, resolveWorkspaceLocale } from "../_locale.js";
import {
  buildBootstrapPrompt,
  collectSourceHosts,
  isSafeRoutinePath,
  isSubHourlyCron,
  isValidCron,
  PROMPT_MODES,
  type PromptMode,
  printPromptModePaste,
  type RoutineIO,
  renderNetworkAccessBlock,
  SUPPORTED_MODELS,
  type SupportedModel,
} from "./generate-watch.js";

/**
 * `radar routine generate pipeline` (ADR-0020 D5 `pipeline`).
 *
 * Emits a Claude Routine YAML whose single session runs the FULL FeedRadar
 * pipeline in sequence — `radar watch run` -> triage -> research -> review —
 * processing items ONE AT A TIME via the self-session `--emit-payload` /
 * `--commit` entrypoints (NOT `--batch`; ADR-0020 D2). The blast radius is
 * bounded by CLI flags (`--max-items` / `--limit`), not the prompt's
 * discretion (D3e), so a `--max-items` flag is the only structural addition
 * over the `watch` generator.
 *
 * The cron / output-path / repository validators and the model roster are
 * shared with `generate-watch.ts` rather than re-declared: routines enforce
 * the identical 1-hour-minimum cron and `.claude/routines/*.yaml` output
 * gate regardless of `<type>`, so a single source keeps the two in lockstep.
 */

/**
 * Default for `--max-items`: how many items one run may triage / research /
 * review. Kept small so the routine's per-run blast radius stays bounded by a
 * deterministic CLI cap (ADR-0020 D3e) rather than the prompt's discretion.
 * Mirrors the conservative default of the GHA `combined-with-triage` cap.
 */
export const PIPELINE_DEFAULT_MAX_ITEMS = 10;

/**
 * Landing / output modes for the pipeline routine's step-8 commit (#301).
 *
 * Symmetric with the GHA `combined-with-triage --output-mode pr|direct-commit`
 * (#258), but the names differ because the mechanics differ:
 *
 * - `pr` (default): open a `claude/pipeline/...` branch + PR and STOP. A human
 *   reviews and merges. This is the ADR-0020 D3a safe default — no unreviewed
 *   routine output reaches the default branch.
 * - `auto-merge`: open the same `claude/pipeline/...` PR, then immediately
 *   `gh pr merge --squash` it so the output lands on `main`. Distinct from the
 *   GHA `direct-commit` (which pushes to main with NO PR at all); here a PR is
 *   always created first. Opt-in because the step-6 self-review makes the PR
 *   review-complete (ADR-0020 D3a opt-in auto-merge).
 *
 * NB: `--auto` (vs immediate `--squash`) is intentionally NOT used — on a repo
 * with no required checks `gh pr merge --auto` never merges, so the routine
 * uses an immediate squash merge instead (#301).
 */
export const OUTPUT_MODES = ["pr", "auto-merge"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

/**
 * Build the instructions step-8 commit/landing block for the given output mode.
 *
 * - `pr`: open a `claude/pipeline/...` branch + PR and stop (the current,
 *   pre-#301 behavior).
 * - `auto-merge`: the same branch + PR, then `git switch main` and
 *   `gh pr merge "${BRANCH}" --squash --delete-branch` so the output lands on
 *   `main`. Switching to `main` before `--delete-branch` keeps the merge
 *   robust; the merge is fail-soft (`|| true`) so a transient failure leaves
 *   the PR open rather than aborting the routine.
 *
 * Emitted with the same 5-space body indentation as the surrounding numbered
 * step (the placeholder sits where the step body starts). Exported for unit
 * testing (mirrors the GHA generator's `buildFinalStep`).
 */
export function buildPipelineLandingStep(mode: OutputMode, locale: Locale = "en"): string {
  // The `${...}` / `$(...)` tokens below are bash expansions in the GENERATED
  // YAML, not JS template placeholders, so they are assembled by concatenation
  // to keep biome's noTemplateCurlyInString quiet (same convention as the GHA
  // `generate-combined-with-triage.ts` builders).
  const BR = "$" + "{BRANCH}";
  const DATE_BRANCH = "$" + "(date -u +%Y%m%d-%H%M)";
  const DATE_COMMIT = "$" + "(date -u +%Y-%m-%d)";
  const common = [
    `       BRANCH="claude/pipeline/${DATE_BRANCH}"`,
    `       git switch -c "${BR}"`,
    "       git add items/ state/ research/",
    `       git commit -m "chore(pipeline): triage/research/review ${DATE_COMMIT}"`,
    `       git push -u origin "${BR}"`,
    `       gh pr create --fill --base main --head "${BR}" || true`,
  ];
  if (mode === "auto-merge") {
    const prose =
      locale === "ja"
        ? [
            "  8. `items/`・`state/`・`research/` が変わったら、それらを `claude/*` ブランチへ",
            "     コミットし、プルリクエストを開き、`main` へ squash-merge する（auto-merge は",
            "     ここではオプトイン — 手順 6 のレビューが PR をレビュー完了にする）:",
          ]
        : [
            "  8. If `items/`, `state/`, or `research/` changed, commit them to a `claude/*`",
            "     branch, open a pull request, then squash-merge it to `main` (auto-merge is",
            "     opt-in here — the step-6 review makes the PR review-complete):",
          ];
    const mergeComment =
      locale === "ja"
        ? [
            "       # マージを堅牢にするため --delete-branch の前に head ブランチから離れ、",
            "       # 即座に squash-merge する（--auto ではない: 必須チェックのない repo では",
            "       # --auto は決してマージしない）。一時的なマージ失敗で実行を中断せず PR を",
            "       # 開いたまま残すよう fail-soft にする。",
          ]
        : [
            "       # Switch off the head branch before --delete-branch so the merge is",
            "       # robust, then squash-merge immediately (NOT --auto: on a repo with no",
            "       # required checks --auto never merges). Fail-soft so a transient merge",
            "       # failure leaves the PR open rather than aborting the run.",
          ];
    return [
      ...prose,
      "",
      "     ```bash",
      "     if ! git diff --quiet items/ state/ research/; then",
      ...common,
      ...mergeComment,
      "       git switch main",
      `       gh pr merge "${BR}" --squash --delete-branch || true`,
      "     fi",
      "     ```",
    ].join("\n");
  }
  const prose =
    locale === "ja"
      ? [
          "  8. `items/`・`state/`・`research/` が変わったら、それらを `claude/*` ブランチへ",
          "     コミットし、プルリクエストを開く（`main` へは push しない）:",
        ]
      : [
          "  8. If `items/`, `state/`, or `research/` changed, commit them to a `claude/*`",
          "     branch and open a pull request (do NOT push to `main`):",
        ];
  return [
    ...prose,
    "",
    "     ```bash",
    "     if ! git diff --quiet items/ state/ research/; then",
    ...common,
    "     fi",
    "     ```",
  ].join("\n");
}

/**
 * Build the hard-constraints output-gate bullet for the given output mode.
 *
 * - `pr`: the current "do NOT push to main; claude/* branch + PR only"
 *   constraint (ADR-0020 D3a, no auto-merge).
 * - `auto-merge`: flips the constraint to say auto-merge is intentional — the
 *   routine opens a `claude/pipeline/...` PR then squash-merges it, and the
 *   step-6 review is what makes the PR review-complete (ADR-0020 D3a opt-in
 *   auto-merge).
 *
 * Exported for unit testing (mirrors the GHA generator's exported builders).
 */
export function buildOutputGateConstraint(mode: OutputMode, locale: Locale = "en"): string {
  if (mode === "auto-merge") {
    if (locale === "ja") {
      return [
        "  - auto-merge はここでは意図的: この routine は `claude/pipeline/...` PR を開いてから",
        "    `main` へ squash-merge する。手順 6 のレビューが PR をレビュー完了にする。",
      ].join("\n");
    }
    return [
      "  - Auto-merge is intentional here: this routine opens a `claude/pipeline/...`",
      "    PR then squash-merges it to `main`. The step-6 review makes the PR",
      "    review-complete.",
    ].join("\n");
  }
  if (locale === "ja") {
    return [
      "  - `main` へ直接 push しない。常に `claude/pipeline/...` ブランチと PR を使う",
      "    （出力ゲート。auto-merge なし）。",
    ].join("\n");
  }
  return [
    "  - Do NOT push to `main` directly. Always use a `claude/pipeline/...` branch",
    "    and a PR (output gate; no auto-merge).",
  ].join("\n");
}

/**
 * Build the `notes:` output-gate sentence for the given output mode. Mirrors
 * `buildOutputGateConstraint` but phrased for the ops `notes` block.
 */
export function buildOutputGateNote(mode: OutputMode, locale: Locale = "en"): string {
  if (mode === "auto-merge") {
    if (locale === "ja") {
      return [
        "  出力は `claude/*` ブランチ / PR にコミットされ、その後 main へ squash-merge される",
        "  （auto-merge はオプトイン。手順 6 のレビューが PR をレビュー完了にする）。",
        "  単一の Claude セッション、spawn なし: GHA パイプラインのクロスエージェント",
        "  レビューはここには存在しない。",
      ].join("\n");
    }
    return [
      "  Output is committed to a `claude/*` branch / PR, then squash-merged to main",
      "  (auto-merge is opt-in; the step-6 review makes the PR review-complete).",
      "  Single Claude session, no spawn: the cross-agent review",
      "  of the GHA pipeline is NOT present here.",
    ].join("\n");
  }
  if (locale === "ja") {
    return [
      "  出力は `claude/*` ブランチ / PR のみにコミットされる（main へ直接ではない）。",
      "  単一の Claude セッション、spawn なし: GHA パイプラインのクロスエージェント",
      "  レビューはここには存在しない。",
    ].join("\n");
  }
  return [
    "  Output is committed to a `claude/*` branch / PR only (never main directly).",
    "  Single Claude session, no spawn: the cross-agent review",
    "  of the GHA pipeline is NOT present here.",
  ].join("\n");
}

/**
 * Resolve the directory holding the bundled routine templates.
 *
 * Mirrors `resolveTemplatesRoot` in `generate-watch.ts`: the compiled CLI lives
 * at `dist/cli/routine/generate-pipeline.js`, so the bundled templates sit at
 * `../../templates` relative to this module. Tests run from source
 * (`src/cli/routine/generate-pipeline.ts`), where the same relative path lands
 * at `src/templates/`.
 */
async function resolveTemplatesRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "templates");
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
 * Render the bundled `pipeline.yaml.tmpl` by substituting the `{{name}}` /
 * `{{repository}}` / `{{cron}}` / `{{timezone}}` / `{{model}}` / `{{maxItems}}`
 * placeholders.
 *
 * Literal `replace` (not a templating engine): the placeholders are simple
 * tokens and we must not expand any other `{{...}}`-looking text in the body.
 * Exported for unit testing in isolation.
 */
export function renderPipelineRoutineTemplate(
  template: string,
  values: {
    name: string;
    repository: string;
    cron: string;
    timezone: string;
    model: string;
    maxItems: number;
    networkAccessBlock: string;
    landingStep: string;
    outputGateConstraint: string;
    outputGateNote: string;
    allowUnrestrictedGitPush: boolean;
  },
): string {
  return template
    .replace(/\{\{name\}\}/g, values.name)
    .replace(/\{\{repository\}\}/g, values.repository)
    .replace(/\{\{cron\}\}/g, values.cron)
    .replace(/\{\{timezone\}\}/g, values.timezone)
    .replace(/\{\{model\}\}/g, values.model)
    .replace(/\{\{maxItems\}\}/g, String(values.maxItems))
    .replace(/\{\{networkAccessBlock\}\}/g, values.networkAccessBlock)
    .replace(/\{\{landingStep\}\}/g, values.landingStep)
    .replace(/\{\{outputGateConstraint\}\}/g, values.outputGateConstraint)
    .replace(/\{\{outputGateNote\}\}/g, values.outputGateNote)
    .replace(/\{\{allowUnrestrictedGitPush\}\}/g, String(values.allowUnrestrictedGitPush));
}

export interface GeneratePipelineRoutineOptions {
  cwd: string;
  name: string;
  repository: string;
  cron: string;
  timezone: string;
  model: SupportedModel;
  maxItems: number;
  /** Landing mode for the step-8 commit (#301). Defaults to `pr`. */
  outputMode: OutputMode;
  /**
   * What to paste into the Web UI Prompt field (#327). Defaults to `inline`
   * (full instructions). Does NOT change the generated YAML — only the
   * completion stdout's paste guidance.
   */
  promptMode?: PromptMode;
  output: string;
  force: boolean;
  /**
   * UI locale selecting the per-locale template subtree and the locale of the
   * code-rendered landing step / output-gate blocks. Defaults to `en` (#315).
   */
  locale?: Locale;
  /** Test seam: override the templates root location. */
  templatesRoot?: string;
  io?: RoutineIO;
}

export interface GeneratePipelineRoutineResult {
  /** Relative path (from `cwd`) of the file that was written. */
  outputPath: string;
}

/**
 * Core implementation of `radar routine generate pipeline` (ADR-0020 D5
 * `pipeline`).
 *
 * Validates the cron (5-field + 1-hour-minimum), output path, repository, and
 * `--max-items` (>= 1), renders the bundled `pipeline.yaml.tmpl`, and writes it
 * under `.claude/routines/`. The completion stdout tells the user how to paste
 * the multi-line fields into the Web UI (yq extraction) and how to apply the
 * schedule via `/schedule`, since Routines has no declarative apply API
 * (ADR-0020 D1).
 */
export async function generatePipelineRoutine(
  options: GeneratePipelineRoutineOptions,
): Promise<GeneratePipelineRoutineResult> {
  const { cwd, name, repository, cron, timezone, model, maxItems, outputMode, output, force } =
    options;
  const promptMode: PromptMode = options.promptMode ?? "inline";
  const locale: Locale = options.locale ?? "en";
  const t = createTranslator(locale);
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));

  if (!(PROMPT_MODES as readonly string[]).includes(promptMode)) {
    throw new Error(
      `invalid --prompt-mode '${promptMode}' (expected one of: ${PROMPT_MODES.join(" | ")})`,
    );
  }
  if (!(OUTPUT_MODES as readonly string[]).includes(outputMode)) {
    throw new Error(
      `invalid --output-mode '${outputMode}' (expected one of: ${OUTPUT_MODES.join(" | ")})`,
    );
  }
  if (!isValidCron(cron)) {
    throw new Error(
      `invalid --cron expression '${cron}' (expected 5-field POSIX cron, e.g. "0 * * * *")`,
    );
  }
  if (isSubHourlyCron(cron)) {
    throw new Error(
      `invalid --cron '${cron}': Claude Routines require a minimum interval of 1 hour ` +
        `(use a fixed minute, e.g. "0 * * * *" hourly or "0 0 * * *" daily; ` +
        `sub-hourly forms like "*/5 * * * *" or "0,30 * * * *" are rejected)`,
    );
  }
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error(`invalid --max-items '${maxItems}' (expected a positive integer)`);
  }
  if (!isSafeRoutinePath(output, cwd)) {
    throw new Error(
      `invalid --output '${output}' (must be a relative path under .claude/routines/ ending in .yaml)`,
    );
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`invalid --repo '${repository}' (expected owner/repo)`);
  }

  const templatesRoot = options.templatesRoot ?? (await resolveTemplatesRoot());
  const templatePath = join(templatesRoot, locale, "routines", "pipeline.yaml.tmpl");
  if (!(await pathExists(templatePath))) {
    throw new Error(`bundled template not found: ${templatePath}`);
  }
  const template = await readFile(templatePath, "utf8");
  const hosts = await collectSourceHosts(cwd, (m) => warn(`routine generate pipeline: ${m}`));
  const rendered = renderPipelineRoutineTemplate(template, {
    name,
    repository,
    cron,
    timezone,
    model,
    maxItems,
    networkAccessBlock: renderNetworkAccessBlock(hosts),
    landingStep: buildPipelineLandingStep(outputMode, locale),
    outputGateConstraint: buildOutputGateConstraint(outputMode, locale),
    outputGateNote: buildOutputGateNote(outputMode, locale),
    allowUnrestrictedGitPush: outputMode === "auto-merge",
  });

  const destAbs = isAbsolute(output) ? output : join(cwd, output);
  const destRel = isAbsolute(output) ? relative(cwd, output) : output;

  if ((await pathExists(destAbs)) && !force) {
    throw new Error(`output file already exists: ${destRel} (use --force to overwrite)`);
  }
  if ((await pathExists(destAbs)) && force) {
    warn(t("cli.routine.generatePipelineOverwriting", { path: destRel }));
  }

  await mkdir(dirname(destAbs), { recursive: true });
  await writeFile(destAbs, rendered, "utf8");

  log(t("cli.routine.generatePipelineWrote", { path: destRel }));
  log(
    t("cli.routine.generatePipelineSummary", {
      name,
      repo: repository,
      cron,
      model,
      maxItems,
      outputMode,
    }),
  );
  if (outputMode === "auto-merge") {
    warn(t("cli.routine.autoMergeWarning", { cmd: "routine generate pipeline" }));
  }
  log("");
  log(t("cli.routine.pasteNoApi"));
  log(t("cli.routine.pasteStep1"));
  log(t("cli.routine.pasteStep2"));
  printPromptModePaste(promptMode, { path: destRel, name }, t, log);
  log(t("cli.routine.pasteStep4"));
  log("");
  log(t("cli.routine.scheduleNote1"));
  log(t("cli.routine.scheduleNote2"));
  log(t("cli.routine.scheduleNote3"));
  log(t("cli.routine.scheduleNote4"));
  log(t("cli.routine.scheduleNote5"));
  log(t("cli.routine.scheduleNote6"));
  log(t("cli.routine.scheduleNote7"));
  log("");
  log(t("cli.routine.pipelineNoSpawn1"));
  log(t("cli.routine.pipelineNoSpawn2"));
  log(t("cli.routine.pipelineItemCaps", { maxItems }));
  if (outputMode === "auto-merge") {
    log(t("cli.routine.outputGateAutoMerge"));
  } else {
    log(t("cli.routine.outputGateBranchPr"));
  }

  return { outputPath: destRel };
}

interface ParsedFlags {
  name: string;
  repository: string;
  cron: string;
  timezone: string;
  model: SupportedModel;
  maxItems: number;
  outputMode: OutputMode;
  promptMode: PromptMode;
  output: string;
  force: boolean;
  /**
   * `--emit-bootstrap-prompt` (#365): print ONLY the bootstrap prompt body to
   * stdout and exit, writing no YAML and printing no paste guidance. Mirrors
   * the `watch` generator so the `routine-setup` Claude skill can fetch the
   * single-sourced prompt for either routine type (epic #363 G3).
   */
  emitBootstrapPrompt: boolean;
  help: boolean;
}

/**
 * Parse `routine generate pipeline` flags.
 *
 * `--output` defaults to `.claude/routines/<name>.yaml`, so it is resolved
 * AFTER the loop once `--name` is known (a `--output` flag, if given, wins).
 */
export function parseGeneratePipelineRoutineArgs(args: string[]): ParsedFlags {
  let name = "feedradar-pipeline";
  let repository = "<owner>/<repo>";
  let cron = "0 * * * *"; // hourly — the Routines minimum interval.
  let timezone = "UTC";
  let model: SupportedModel = "claude-sonnet-4-6";
  let maxItems = PIPELINE_DEFAULT_MAX_ITEMS;
  let outputMode: OutputMode = "pr";
  let promptMode: PromptMode = "inline";
  let output: string | undefined;
  let force = false;
  let emitBootstrapPrompt = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }
    if (a === "--emit-bootstrap-prompt") {
      emitBootstrapPrompt = true;
      continue;
    }
    if (a === "--name") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      name = value;
      continue;
    }
    if (a === "--repo" || a === "--repository") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      repository = value;
      continue;
    }
    if (a === "--cron") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      cron = value;
      continue;
    }
    if (a === "--timezone" || a === "--tz") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      timezone = value;
      continue;
    }
    if (a === "--model") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      if (!(SUPPORTED_MODELS as readonly string[]).includes(value)) {
        throw new Error(
          `option --model expects one of: ${SUPPORTED_MODELS.join(" | ")}, got '${value}'`,
        );
      }
      model = value as SupportedModel;
      continue;
    }
    if (a === "--max-items") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`option --max-items expects a positive integer, got '${value}'`);
      }
      maxItems = n;
      continue;
    }
    if (a === "--output-mode") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      if (!(OUTPUT_MODES as readonly string[]).includes(value)) {
        throw new Error(
          `option --output-mode expects one of: ${OUTPUT_MODES.join(" | ")}, got '${value}'`,
        );
      }
      outputMode = value as OutputMode;
      continue;
    }
    if (a === "--prompt-mode") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      if (!(PROMPT_MODES as readonly string[]).includes(value)) {
        throw new Error(
          `option --prompt-mode expects one of: ${PROMPT_MODES.join(" | ")}, got '${value}'`,
        );
      }
      promptMode = value as PromptMode;
      continue;
    }
    if (a === "--output") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      output = value;
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

  return {
    name,
    repository,
    cron,
    timezone,
    model,
    maxItems,
    outputMode,
    promptMode,
    output: output ?? join(".claude", "routines", `${name}.yaml`),
    force,
    emitBootstrapPrompt,
    help,
  };
}

export function printGeneratePipelineRoutineHelp(t: Translator, log: (m: string) => void): void {
  log(
    t("cli.routine.generatePipelineHelp", {
      models: SUPPORTED_MODELS.join(" | "),
      maxItems: PIPELINE_DEFAULT_MAX_ITEMS,
    }),
  );
}

/**
 * Entry point invoked by `runRoutine` (in `src/cli/routine.ts`) when the user
 * types `radar routine generate pipeline`. Translates parsed flags into
 * `generatePipelineRoutine` arguments and surfaces validation errors with the
 * `routine generate pipeline:` prefix to match the rest of the CLI.
 */
export async function runGeneratePipelineRoutine(
  args: string[],
  io: RoutineIO = {},
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
      error(`routine generate pipeline: ${e.message}`);
      return 2;
    }
    throw e;
  }

  let parsed: ParsedFlags;
  try {
    parsed = parseGeneratePipelineRoutineArgs(rest);
  } catch (e) {
    error(`routine generate pipeline: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  // Resolve the locale before the help branch so `--help` honors --lang / env /
  // config (the per-type help is now sourced from the i18n catalog, #337).
  const locale = await resolveWorkspaceLocale({ flag: langFlag, cwd, warn: error });
  const t = createTranslator(locale);

  if (parsed.help) {
    printGeneratePipelineRoutineHelp(t, log);
    return 0;
  }

  // --emit-bootstrap-prompt (#365): print ONLY the bootstrap prompt body
  // (read-only — no YAML written, no paste guidance), single-sourced from
  // `buildBootstrapPrompt` so it matches the generator's bootstrap paste output
  // byte-for-byte (epic #363 G3). `path` matches the generator's `destRel`.
  if (parsed.emitBootstrapPrompt) {
    const promptPath = isAbsolute(parsed.output) ? relative(cwd, parsed.output) : parsed.output;
    log(buildBootstrapPrompt({ name: parsed.name, path: promptPath }, t));
    return 0;
  }

  try {
    await generatePipelineRoutine({
      cwd,
      name: parsed.name,
      repository: parsed.repository,
      cron: parsed.cron,
      timezone: parsed.timezone,
      model: parsed.model,
      maxItems: parsed.maxItems,
      outputMode: parsed.outputMode,
      promptMode: parsed.promptMode,
      output: parsed.output,
      force: parsed.force,
      locale,
      io,
    });
    return 0;
  } catch (e) {
    error(`routine generate pipeline: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
