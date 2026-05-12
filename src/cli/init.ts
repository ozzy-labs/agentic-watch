import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "./index.js";

/**
 * Resolve the directory holding the bundled skill assets (`dist/skills/`).
 *
 * The compiled CLI lives at `dist/cli/init.js`, so the bundled skills sit at
 * `../skills` relative to this module. During tests we may be running from
 * source (`src/cli/init.ts`), so we also fall back to `src/skills/` if the
 * compiled location does not exist.
 */
async function resolveSkillsRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled layout: dist/cli/init.js -> dist/skills
  const compiled = resolve(here, "../skills");
  if (await pathExists(compiled)) {
    return compiled;
  }
  // Source layout fallback: src/cli/init.ts -> src/skills (used by tests run on .ts).
  const source = resolve(here, "../skills");
  return source;
}

/** Same resolution strategy as `resolveSkillsRoot`, but for `src|dist/templates`. */
async function resolveTemplatesRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, "../templates");
  if (await pathExists(compiled)) {
    return compiled;
  }
  return resolve(here, "../templates");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface InitOptions {
  cwd: string;
  force: boolean;
  /** Override the source location of bundled skills (used by tests). */
  skillsRoot?: string;
  /** Override the source location of bundled init templates (used by tests). */
  templatesRoot?: string;
  /**
   * Emit the Claude Routines schedule template
   * (`claude/routines/watch-daily.md`).
   */
  withRoutines?: boolean;
  /**
   * Emit the GitHub Actions schedule template (`.github/workflows/watch.yaml`).
   */
  withActions?: boolean;
  /** Sink for warnings; defaults to console.warn. */
  warn?: (message: string) => void;
  /** Sink for info messages; defaults to console.log. */
  info?: (message: string) => void;
}

interface InitResult {
  createdDirs: string[];
  copiedFiles: string[];
  skippedFiles: string[];
}

const WORKSPACE_DIRS = ["sources", "state", "items", "research", "templates"] as const;
const BUNDLED_SKILLS = ["research", "review", "update"] as const;

/**
 * Schedule scaffolds that `init` may emit on opt-in flags.
 *
 * - `src`: bundled template path under `<templatesRoot>/`
 * - `dest`: where the file lands in the user's workspace
 *
 * See ADR-0004 for the policy: `agentic-watch` does not run schedules
 * itself; these scaffolds wire it into Claude Routines / GitHub Actions.
 */
const SCHEDULE_SCAFFOLDS = {
  routines: {
    src: "routines/watch-daily.md",
    dest: ["claude", "routines", "watch-daily.md"] as const,
  },
  actions: {
    src: "workflows/watch.yaml",
    dest: [".github", "workflows", "watch.yaml"] as const,
  },
} as const;

/**
 * Initialize the current directory as an agentic-watch workspace.
 *
 * Creates the canonical workspace directories and copies bundled SKILL.md
 * files into `.agents/skills/<name>/SKILL.md`. Existing files are protected
 * unless `force` is true.
 *
 * Claude Code adapter integration: `init` currently writes a single canonical
 * copy under `.agents/skills/`. We do not duplicate or symlink into
 * `.claude/skills/` because `@ozzylabs/skills` Renovate preset manages that
 * directory separately and we want to avoid surprise overwrites of skills
 * shipped through the preset. This decision is logged on
 * https://github.com/ozzy-labs/agentic-watch/issues/9 § 2 and will be revisited
 * if user feedback requires direct Claude Code discoverability for bundled
 * skills.
 */
export async function initWorkspace(options: InitOptions): Promise<InitResult> {
  const { cwd, force } = options;
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const info = options.info ?? ((m: string) => console.log(m));

  const createdDirs: string[] = [];
  const copiedFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const dir of WORKSPACE_DIRS) {
    const abs = join(cwd, dir);
    await mkdir(abs, { recursive: true });
    createdDirs.push(dir);
  }

  const skillsRoot = options.skillsRoot ?? (await resolveSkillsRoot());

  for (const skill of BUNDLED_SKILLS) {
    const src = join(skillsRoot, skill, "SKILL.md");
    const destDir = join(cwd, ".agents", "skills", skill);
    const dest = join(destDir, "SKILL.md");
    await mkdir(destDir, { recursive: true });

    if (!(await pathExists(src))) {
      warn(`init: bundled skill not found, skipped: ${src}`);
      skippedFiles.push(`.agents/skills/${skill}/SKILL.md`);
      continue;
    }

    if ((await pathExists(dest)) && !force) {
      warn(
        `init: skipped existing file (use --force to overwrite): .agents/skills/${skill}/SKILL.md`,
      );
      skippedFiles.push(`.agents/skills/${skill}/SKILL.md`);
      continue;
    }

    await copyFile(src, dest);
    copiedFiles.push(`.agents/skills/${skill}/SKILL.md`);
  }

  if (options.withRoutines) {
    await emitScaffold({
      cwd,
      force,
      templatesRoot: options.templatesRoot,
      scaffold: SCHEDULE_SCAFFOLDS.routines,
      copiedFiles,
      skippedFiles,
      warn,
    });
  }

  if (options.withActions) {
    await emitScaffold({
      cwd,
      force,
      templatesRoot: options.templatesRoot,
      scaffold: SCHEDULE_SCAFFOLDS.actions,
      copiedFiles,
      skippedFiles,
      warn,
    });
  }

  info(`init: workspace ready at ${cwd}`);
  info(`init: directories created: ${createdDirs.join(", ")}`);
  if (copiedFiles.length > 0) {
    info(`init: skills copied: ${copiedFiles.join(", ")}`);
  }
  if (skippedFiles.length > 0) {
    info(`init: files skipped: ${skippedFiles.join(", ")}`);
  }

  return { createdDirs, copiedFiles, skippedFiles };
}

/**
 * Copy one bundled schedule scaffold into `cwd`. Existing files are protected
 * unless `force` is true (mirrors the bundled-skills path).
 */
async function emitScaffold(args: {
  cwd: string;
  force: boolean;
  templatesRoot: string | undefined;
  scaffold: { src: string; dest: readonly string[] };
  copiedFiles: string[];
  skippedFiles: string[];
  warn: (message: string) => void;
}): Promise<void> {
  const { cwd, force, scaffold, copiedFiles, skippedFiles, warn } = args;
  const templatesRoot = args.templatesRoot ?? (await resolveTemplatesRoot());
  const src = join(templatesRoot, scaffold.src);
  const dest = join(cwd, ...scaffold.dest);
  const relDest = scaffold.dest.join("/");

  if (!(await pathExists(src))) {
    warn(`init: bundled template not found, skipped: ${src}`);
    skippedFiles.push(relDest);
    return;
  }

  await mkdir(dirname(dest), { recursive: true });

  if ((await pathExists(dest)) && !force) {
    warn(`init: skipped existing file (use --force to overwrite): ${relDest}`);
    skippedFiles.push(relDest);
    return;
  }

  await copyFile(src, dest);
  copiedFiles.push(relDest);
}

interface ParsedArgs {
  force: boolean;
  withRoutines: boolean;
  withActions: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let force = false;
  let withRoutines = false;
  let withActions = false;
  let help = false;
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--with-routines") {
      withRoutines = true;
    } else if (arg === "--with-actions") {
      withActions = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    }
  }
  return { force, withRoutines, withActions, help };
}

export const initCommand: Command = {
  name: "init",
  summary: "Initialize a workspace (sources/items/state/research/templates)",
  run: async (args) => {
    const { force, withRoutines, withActions, help } = parseArgs(args);
    if (help) {
      console.log("Usage: agentic-watch init [--force] [--with-routines] [--with-actions]");
      console.log("");
      console.log("Creates the workspace directories and copies bundled skills");
      console.log("(research / review / update) into .agents/skills/.");
      console.log("");
      console.log("Options:");
      console.log("  --force            Overwrite existing files");
      console.log(
        "  --with-routines    Generate claude/routines/watch-daily.md (Claude Routines scaffold)",
      );
      console.log(
        "  --with-actions     Generate .github/workflows/watch.yaml (GitHub Actions cron scaffold)",
      );
      return 0;
    }
    await initWorkspace({
      cwd: process.cwd(),
      force,
      withRoutines,
      withActions,
    });
    return 0;
  },
};
