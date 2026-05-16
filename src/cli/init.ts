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

/**
 * Resolve the directory holding the bundled Claude Code slash-command
 * wrappers (`dist/claude-skills/`).
 *
 * These are distinct from the engine SKILLs at `dist/skills/`. The engine
 * SKILLs land at `<cwd>/.agents/skills/<name>/SKILL.md` and are read by the
 * agent adapter when the CLI spawns claude/codex/gemini/copilot. The Claude
 * discovery skills land at `<cwd>/.claude/skills/<name>/SKILL.md` so that
 * Claude Code, when opened in the workspace, surfaces `/research` /
 * `/review` / `/update` / `/dismiss` as invocable slash commands. The
 * discovery skills are thin wrappers — they shell out to the `agentic-watch`
 * CLI rather than duplicating the engine procedure.
 *
 * See ADR-0007 (revised 2026-05-17) for the policy and `docs/design/
 * skill-design.md` for the SSoT vs discovery layering rationale.
 */
async function resolveClaudeSkillsRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, "../claude-skills");
  if (await pathExists(compiled)) {
    return compiled;
  }
  return resolve(here, "../claude-skills");
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
  /** Override the source location of bundled engine skills (used by tests). */
  skillsRoot?: string;
  /** Override the source location of bundled init templates (used by tests). */
  templatesRoot?: string;
  /** Override the source location of bundled Claude discovery skills (used by tests). */
  claudeSkillsRoot?: string;
  /**
   * Skip writing Claude Code slash-command wrappers to
   * `<cwd>/.claude/skills/`. Useful for workspaces that already manage that
   * directory via the `@ozzylabs/skills` Renovate preset and don't want
   * agentic-watch's discovery skills to land alongside the preset ones.
   *
   * The engine SKILLs at `<cwd>/.agents/skills/` (which the agent adapter
   * reads when the CLI spawns the agent) are always written regardless of
   * this flag; they are the SSoT.
   */
  noClaudeSkills?: boolean;
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

/**
 * Engine SKILLs (SSoT): canonical procedure documents that the agent adapter
 * reads when the CLI spawns claude/codex/gemini/copilot. They land at
 * `<cwd>/.agents/skills/<name>/SKILL.md`.
 */
const BUNDLED_SKILLS = ["research", "review", "update"] as const;

/**
 * Claude Code discovery SKILLs: thin slash-command wrappers that surface
 * `/research` / `/review` / `/update` / `/dismiss` inside Claude Code
 * interactive sessions opened in the workspace. They land at
 * `<cwd>/.claude/skills/<name>/SKILL.md` and delegate to the `agentic-watch`
 * CLI; they do not duplicate the engine procedure.
 *
 * Note `dismiss` is here but NOT in `BUNDLED_SKILLS` — the dismiss command
 * does not invoke an agent (no LLM call), so there is no engine SKILL for
 * it. The slash-command wrapper is purely a UX affordance for Claude Code
 * users (vs typing `agentic-watch dismiss` in a terminal).
 *
 * See ADR-0007 (revised 2026-05-17) for the SSoT vs discovery split.
 */
const CLAUDE_DISCOVERY_SKILLS = ["research", "review", "update", "dismiss"] as const;

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
 * Claude Code discoverability (ADR-0007, revised 2026-05-17 via #75): in
 * addition to the engine SKILLs at `.agents/skills/`, `init` also writes
 * thin slash-command wrappers to `.claude/skills/` so that Claude Code,
 * when opened interactively in the workspace, surfaces `/research` /
 * `/review` / `/update` / `/dismiss`. The wrappers delegate to the
 * `agentic-watch` CLI rather than duplicating the engine procedure (the
 * engine SKILL at `.agents/skills/<name>/SKILL.md` remains the SSoT).
 * Existing files are protected, so workspaces that already manage
 * `.claude/skills/` via the `@ozzylabs/skills` Renovate preset won't be
 * surprised; alternatively use `--no-claude-skills` to skip the discovery
 * layer entirely.
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

  if (!options.noClaudeSkills) {
    const claudeSkillsRoot = options.claudeSkillsRoot ?? (await resolveClaudeSkillsRoot());

    for (const skill of CLAUDE_DISCOVERY_SKILLS) {
      const src = join(claudeSkillsRoot, skill, "SKILL.md");
      const destDir = join(cwd, ".claude", "skills", skill);
      const dest = join(destDir, "SKILL.md");
      await mkdir(destDir, { recursive: true });

      if (!(await pathExists(src))) {
        warn(`init: bundled claude discovery skill not found, skipped: ${src}`);
        skippedFiles.push(`.claude/skills/${skill}/SKILL.md`);
        continue;
      }

      if ((await pathExists(dest)) && !force) {
        warn(
          `init: skipped existing file (use --force to overwrite): .claude/skills/${skill}/SKILL.md`,
        );
        skippedFiles.push(`.claude/skills/${skill}/SKILL.md`);
        continue;
      }

      await copyFile(src, dest);
      copiedFiles.push(`.claude/skills/${skill}/SKILL.md`);
    }
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
  noClaudeSkills: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let force = false;
  let withRoutines = false;
  let withActions = false;
  let noClaudeSkills = false;
  let help = false;
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--with-routines") {
      withRoutines = true;
    } else if (arg === "--with-actions") {
      withActions = true;
    } else if (arg === "--no-claude-skills") {
      noClaudeSkills = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    }
  }
  return { force, withRoutines, withActions, noClaudeSkills, help };
}

export const initCommand: Command = {
  name: "init",
  summary: "Initialize a workspace (sources/items/state/research/templates)",
  run: async (args) => {
    const { force, withRoutines, withActions, noClaudeSkills, help } = parseArgs(args);
    if (help) {
      console.log(
        "Usage: agentic-watch init [--force] [--with-routines] [--with-actions] [--no-claude-skills]",
      );
      console.log("");
      console.log("Creates the workspace directories and copies bundled skills:");
      console.log("  - Engine SKILLs (SSoT): .agents/skills/{research,review,update}/SKILL.md");
      console.log(
        "  - Claude Code slash-command wrappers: .claude/skills/{research,review,update,dismiss}/SKILL.md",
      );
      console.log("");
      console.log("Options:");
      console.log("  --force              Overwrite existing files");
      console.log(
        "  --with-routines      Generate claude/routines/watch-daily.md (Claude Routines scaffold)",
      );
      console.log(
        "  --with-actions       Generate .github/workflows/watch.yaml (GitHub Actions cron scaffold)",
      );
      console.log("  --no-claude-skills   Skip writing slash-command wrappers to .claude/skills/");
      console.log(
        "                       (useful if @ozzylabs/skills Renovate preset manages that directory)",
      );
      return 0;
    }
    await initWorkspace({
      cwd: process.cwd(),
      force,
      withRoutines,
      withActions,
      noClaudeSkills,
    });
    return 0;
  },
};
