import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sinks for the `routine generate watch` command's user-facing output.
 *
 * Mirrors `WorkflowIO` in `src/cli/workflow.ts`: the CLI binds these to
 * `console.*` by default; tests inject capturing sinks so they can assert
 * against printed lines without poking at stdio.
 */
export interface RoutineIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * Models supported by `--model`. Claude Routines run on the subscription
 * Claude session (ADR-0020 D2), so the only valid models are Claude family
 * identifiers. The literal list keeps the help text and validation in sync.
 */
export const SUPPORTED_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-6",
] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

/**
 * Resolve the directory holding the bundled routine templates.
 *
 * Mirrors `resolveTemplatesRoot` in `src/cli/workflow/generate-watch.ts`:
 * the compiled CLI lives at `dist/cli/routine/generate-watch.js`, so the
 * bundled templates sit at `../../templates` relative to this module.
 * During tests we may run from source (`src/cli/routine/generate-watch.ts`),
 * where the same relative path lands at `src/templates/`.
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
 * Validate a 5-field POSIX cron expression for a Claude Routine schedule.
 *
 * DRY note (ADR-0020 / #280): the structural 5-field grammar deliberately
 * mirrors `isValidCron` in `src/cli/workflow/generate-watch.ts`, but the two
 * are kept SEPARATE on purpose. GitHub Actions accepts arbitrary sub-hourly
 * cron (e.g. `*\/5 * * * *`); Claude Routines enforce a **1-hour minimum
 * interval**. Sharing one validator would force the workflow side to either
 * over-reject (breaking existing 5-minute GHA crons) or this side to
 * under-reject (generating a routine that the Web UI rejects on apply). So
 * this validator layers a sub-hourly rejection (`isSubHourlyCron`) on top of
 * the same structural check.
 *
 * Range bounds are NOT enforced (the Web UI rejects out-of-range on apply);
 * keeping the check structural avoids a cron-parser dependency.
 */
export function isValidCron(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  const tokenPattern = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/;
  for (const field of fields) {
    if (field.length === 0) return false;
    for (const token of field.split(",")) {
      if (token.length === 0) return false;
      if (!tokenPattern.test(token)) return false;
    }
  }
  return true;
}

/**
 * Detect a cron expression that would fire more often than once per hour.
 *
 * Claude Routines reject sub-hourly schedules (ADR-0020: minimum interval is
 * 1 hour). We catch the common sub-hourly shapes in the MINUTE field (field
 * 0) before the file is written so the user gets a clear error instead of a
 * Web UI rejection at apply time:
 *
 *   - `*` in the minute field => fires every minute.
 *   - `*\/N` step in the minute field => fires N times within the hour.
 *   - a comma list with 2+ distinct minutes (e.g. `0,30 * * * *`) => fires
 *     multiple times per hour.
 *   - a range with `-` (e.g. `0-30 * * * *`) => fires every minute in range.
 *
 * A single fixed minute (`0`, `30`, `15`) is hourly-or-coarser and accepted.
 * Assumes `isValidCron(expr)` already passed (5 well-formed fields).
 */
export function isSubHourlyCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  const minute = fields[0];
  if (minute === undefined) return true;
  if (minute === "*") return true;
  if (minute.includes("/")) return true; // step => multiple firings/hour
  if (minute.includes("-")) return true; // range => every minute in range
  // Comma list: more than one distinct minute => multiple firings/hour.
  const minutes = new Set(minute.split(","));
  if (minutes.size > 1) return true;
  return false;
}

/**
 * Validate that the requested `--output` path lands under `.claude/routines/`
 * relative to the workspace root and ends in `.yaml`.
 *
 * DRY note (ADR-0020 / #280): the traversal + absolute-path rejection mirrors
 * `isSafeWorkflowPath` in `src/cli/workflow/generate-watch.ts`, but the
 * allowed directory (`.claude/routines/` vs `.github/workflows/`) and
 * extension policy (`.yaml` only — the Web UI form is YAML, `.yml` would not
 * match the README convention) differ, so the two are kept separate.
 */
export function isSafeRoutinePath(outputPath: string, cwd: string): boolean {
  if (isAbsolute(outputPath)) {
    const allowedDir = resolve(cwd, ".claude", "routines");
    const resolved = resolve(outputPath);
    const rel = relative(allowedDir, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    return /\.yaml$/i.test(resolved);
  }
  const normalized = normalize(outputPath);
  if (normalized.split(/[\\/]/).includes("..")) return false;
  const required = `${join(".claude", "routines")}/`;
  const unixified = normalized.replace(/\\/g, "/");
  if (!unixified.startsWith(required.replace(/\\/g, "/"))) return false;
  return /\.yaml$/i.test(unixified);
}

/**
 * Render the bundled routine template by substituting `{{name}}` /
 * `{{repository}}` / `{{cron}}` / `{{timezone}}` / `{{model}}` placeholders.
 *
 * Literal `replace` (not a templating engine): the placeholders are simple
 * tokens and we must not expand any other `{{...}}`-looking text in the body.
 * Exported for unit testing in isolation.
 */
export function renderWatchRoutineTemplate(
  template: string,
  values: {
    name: string;
    repository: string;
    cron: string;
    timezone: string;
    model: string;
  },
): string {
  return template
    .replace(/\{\{name\}\}/g, values.name)
    .replace(/\{\{repository\}\}/g, values.repository)
    .replace(/\{\{cron\}\}/g, values.cron)
    .replace(/\{\{timezone\}\}/g, values.timezone)
    .replace(/\{\{model\}\}/g, values.model);
}

export interface GenerateWatchRoutineOptions {
  cwd: string;
  name: string;
  repository: string;
  cron: string;
  timezone: string;
  model: SupportedModel;
  output: string;
  force: boolean;
  /** Test seam: override the templates root location. */
  templatesRoot?: string;
  io?: RoutineIO;
}

export interface GenerateWatchRoutineResult {
  /** Relative path (from `cwd`) of the file that was written. */
  outputPath: string;
}

/**
 * Core implementation of `radar routine generate watch` (ADR-0020 D5 `watch`).
 *
 * Validates the cron (5-field + 1-hour-minimum), output path, and repository,
 * renders the bundled `watch.yaml.tmpl`, and writes it under
 * `.claude/routines/`. The completion stdout tells the user how to paste the
 * multi-line fields into the Web UI (yq extraction) and how to apply the
 * schedule via `/schedule`, since Routines has no declarative apply API
 * (ADR-0020 D1).
 */
export async function generateWatchRoutine(
  options: GenerateWatchRoutineOptions,
): Promise<GenerateWatchRoutineResult> {
  const { cwd, name, repository, cron, timezone, model, output, force } = options;
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));

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
  if (!isSafeRoutinePath(output, cwd)) {
    throw new Error(
      `invalid --output '${output}' (must be a relative path under .claude/routines/ ending in .yaml)`,
    );
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`invalid --repo '${repository}' (expected owner/repo)`);
  }

  const templatesRoot = options.templatesRoot ?? (await resolveTemplatesRoot());
  const templatePath = join(templatesRoot, "routines", "watch.yaml.tmpl");
  if (!(await pathExists(templatePath))) {
    throw new Error(`bundled template not found: ${templatePath}`);
  }
  const template = await readFile(templatePath, "utf8");
  const rendered = renderWatchRoutineTemplate(template, {
    name,
    repository,
    cron,
    timezone,
    model,
  });

  const destAbs = isAbsolute(output) ? output : join(cwd, output);
  const destRel = isAbsolute(output) ? relative(cwd, output) : output;

  if ((await pathExists(destAbs)) && !force) {
    throw new Error(`output file already exists: ${destRel} (use --force to overwrite)`);
  }
  if ((await pathExists(destAbs)) && force) {
    warn(`routine generate watch: overwriting existing file ${destRel}`);
  }

  await mkdir(dirname(destAbs), { recursive: true });
  await writeFile(destAbs, rendered, "utf8");

  log(`routine generate watch: wrote ${destRel}`);
  log(
    `routine generate watch: name='${name}', repo='${repository}', cron='${cron}', model='${model}'`,
  );
  log("");
  log("Routines has no declarative apply API — paste this routine into the Web UI by hand:");
  log("  1. Open https://claude.ai/code/routines and click New routine.");
  log(
    "  2. Fill the form fields from the YAML (Name / Model / Repositories / Trigger / Permissions).",
  );
  log("  3. For the multi-line Instructions and Setup script fields, extract them with yq:");
  log(`       yq -r '.instructions'             ${destRel}`);
  log(`       yq -r '.environment.setup_script' ${destRel}`);
  log(
    "  4. After registering, copy the issued routine_id (trig_xxxx) back into the YAML and set status: active.",
  );
  log("");
  log("Or apply the schedule from the CLI with /schedule, e.g.:");
  log(`     /schedule create --name '${name}' --cron '${cron}' --repo '${repository}'`);
  log("");
  log(
    "Output gate (ADR-0020 D3a): this routine writes to a claude/* branch / PR only — never main directly.",
  );

  return { outputPath: destRel };
}

interface ParsedFlags {
  name: string;
  repository: string;
  cron: string;
  timezone: string;
  model: SupportedModel;
  output: string;
  force: boolean;
  help: boolean;
}

/**
 * Parse `routine generate watch` flags.
 *
 * `--output` defaults to `.claude/routines/<name>.yaml`, so it is resolved
 * AFTER the loop once `--name` is known (a `--output` flag, if given, wins).
 */
export function parseGenerateWatchRoutineArgs(args: string[]): ParsedFlags {
  let name = "feedradar-watch";
  let repository = "<owner>/<repo>";
  let cron = "0 * * * *"; // hourly — the Routines minimum interval.
  let timezone = "UTC";
  let model: SupportedModel = "claude-sonnet-4-6";
  let output: string | undefined;
  let force = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      help = true;
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
    output: output ?? join(".claude", "routines", `${name}.yaml`),
    force,
    help,
  };
}

export function printGenerateWatchRoutineHelp(log: (m: string) => void): void {
  log("Usage: radar routine generate watch [options]");
  log("");
  log("Generates a Claude Code Routine YAML that runs `radar watch run` on a schedule");
  log("and commits detected items/state to a claude/* branch (ADR-0020 D5 `watch`).");
  log("The routine completes in one Claude session — it does NOT spawn other agents.");
  log("");
  log("Options:");
  log('  --name <name>         Routine name (default: "feedradar-watch")');
  log("                        Also the default output filename.");
  log("  --repo <owner/repo>   Target repository (default: <owner>/<repo>)");
  log('  --cron <expression>   5-field cron, min interval 1 HOUR (default: "0 * * * *")');
  log('                        Sub-hourly (e.g. "*/5 * * * *") is rejected.');
  log('  --timezone <tz>       Schedule timezone (default: "UTC")');
  log(`  --model <name>        ${SUPPORTED_MODELS.join(" | ")}`);
  log("                        (default: claude-sonnet-4-6)");
  log("  --output <path>       Output file under .claude/routines/");
  log("                        (default: .claude/routines/<name>.yaml)");
  log("  --force, -f           Overwrite existing output file");
}

/**
 * Entry point invoked by `runRoutine` (in `src/cli/routine.ts`) when the user
 * types `radar routine generate watch`. Translates parsed flags into
 * `generateWatchRoutine` arguments and surfaces validation errors with the
 * `routine generate watch:` prefix to match the rest of the CLI.
 */
export async function runGenerateWatchRoutine(
  args: string[],
  io: RoutineIO = {},
  cwd: string = process.cwd(),
): Promise<number> {
  const log = io.log ?? ((m: string) => console.log(m));
  const error = io.error ?? ((m: string) => console.error(m));

  let parsed: ParsedFlags;
  try {
    parsed = parseGenerateWatchRoutineArgs(args);
  } catch (e) {
    error(`routine generate watch: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printGenerateWatchRoutineHelp(log);
    return 0;
  }

  try {
    await generateWatchRoutine({
      cwd,
      name: parsed.name,
      repository: parsed.repository,
      cron: parsed.cron,
      timezone: parsed.timezone,
      model: parsed.model,
      output: parsed.output,
      force: parsed.force,
      io,
    });
    return 0;
  } catch (e) {
    error(`routine generate watch: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
