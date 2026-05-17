import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
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

/**
 * Resolve the directory holding the bundled Gemini CLI slash command TOMLs
 * (`dist/gemini-commands/`).
 *
 * These are distinct from the engine SKILLs at `dist/skills/` and the Claude
 * Code discovery wrappers at `dist/claude-skills/`. Gemini CLI surfaces slash
 * commands from `.gemini/commands/<name>.toml` (TOML format with `prompt` and
 * `description` keys). The bundled TOMLs are thin wrappers — they tell Gemini
 * to shell out to the `agentic-watch` CLI with `{{args}}` interpolation; the
 * canonical procedure stays in the engine SKILLs (SSoT) under
 * `.agents/skills/`.
 *
 * See ADR-0007 (revised 2026-05-17 c) for the five-layer init bundle and the
 * cross-agent slash-command parity rationale.
 */
async function resolveGeminiCommandsRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, "../gemini-commands");
  if (await pathExists(compiled)) {
    return compiled;
  }
  return resolve(here, "../gemini-commands");
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
  /** Override the source location of bundled Gemini CLI command TOMLs (used by tests). */
  geminiCommandsRoot?: string;
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
   * Skip writing Gemini CLI slash-command TOMLs to
   * `<cwd>/.gemini/commands/`. Useful for workspaces that already manage
   * that directory via another mechanism, or that don't use Gemini CLI.
   *
   * The engine SKILLs at `<cwd>/.agents/skills/` are always written
   * regardless of this flag; they are the SSoT. Codex CLI / Gemini CLI
   * interactive sessions also fall back to the engine SKILLs via the
   * "Invocation modes" dual-mode procedure when no slash command is
   * configured.
   */
  noGeminiCommands?: boolean;
  /**
   * Skip writing `<cwd>/AGENTS.md`. By default `init` copies the bundled
   * AGENTS.md template into the workspace so that agent CLIs which auto-read
   * an agent-agnostic instructions file (Codex / Gemini / Copilot) get
   * workspace context (available commands, typical workflow, docs pointers)
   * the moment a user opens an interactive session.
   *
   * Useful for workspaces that already manage their own AGENTS.md (e.g. a
   * monorepo with project-wide instructions) and don't want agentic-watch's
   * boilerplate to land at the root.
   *
   * See ADR-0007 (revised 2026-05-17 b) for the four-layer init bundle
   * (engine SKILL / claude discovery / AGENTS.md / schedule scaffolds).
   */
  noAgentsMd?: boolean;
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
 * Data directories that receive a `.gitkeep` placeholder so the empty
 * directory survives an initial `git add .` commit.
 *
 * AGENTS.md's "データ管理ポリシー" recommends committing `sources/` / `items/`
 * / `state/` / `research/` to git (state preservation for scheduled runs,
 * audit trail for research history). Git does not track empty directories,
 * so without a placeholder, a user who runs `init` and then `git add .`
 * loses the directory layout entirely.
 *
 * `templates/` is intentionally excluded — the bundled `default.md` ships
 * via a separate `init` codepath (see ADR-0007 follow-up) and serves as
 * its own placeholder.
 */
const GITKEEP_DIRS = ["sources", "items", "state", "research"] as const;

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
 * Gemini CLI slash commands: thin TOML wrappers that surface `/research` /
 * `/review` / `/update` / `/dismiss` inside Gemini CLI interactive sessions
 * opened in the workspace. They land at `<cwd>/.gemini/commands/<name>.toml`
 * and delegate to the `agentic-watch` CLI via `{{args}}` interpolation; they
 * do not duplicate the engine procedure.
 *
 * Note `dismiss` is here but NOT in `BUNDLED_SKILLS` — the dismiss command
 * does not invoke an agent (no LLM call), so there is no engine SKILL for
 * it. The TOML is purely a UX affordance for Gemini CLI users.
 *
 * See ADR-0007 (revised 2026-05-17 c) for the five-layer init bundle and the
 * cross-agent slash-command parity rationale (#78).
 */
const GEMINI_COMMANDS = ["research", "review", "update", "dismiss"] as const;

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
 * Bundled agent-agnostic instructions file emitted by default at the
 * workspace root. Codex CLI / Gemini CLI / GitHub Copilot CLI auto-read
 * `AGENTS.md` from project root; Claude Code does not, but the standard
 * pattern is `CLAUDE.md` → `@AGENTS.md` include.
 *
 * See ADR-0007 (revised 2026-05-17 b) for the four-layer init bundle.
 */
const AGENTS_MD_SCAFFOLD = {
  src: "agents/AGENTS.md",
  dest: ["AGENTS.md"] as const,
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
 *
 * Multi-agent context (ADR-0007, revised 2026-05-17 b via #77): `init`
 * also writes an agent-agnostic `AGENTS.md` at the workspace root. Codex
 * CLI, Gemini CLI, and GitHub Copilot CLI auto-read this file when opened
 * interactively in the workspace, giving those agents context about
 * available commands, typical workflow, and docs pointers without any
 * extra setup. Opt out via `--no-agents-md` (workspaces that already have
 * their own AGENTS.md).
 *
 * Gemini CLI slash commands (ADR-0007, revised 2026-05-17 c via #78):
 * `init` writes Gemini CLI's native slash command TOMLs at
 * `<cwd>/.gemini/commands/{research,review,update,dismiss}.toml`. These
 * thin wrappers shell out to the `agentic-watch` CLI through Gemini's
 * `{{args}}` interpolation, surfacing `/research` etc. inside Gemini CLI
 * interactive sessions. Opt out via `--no-gemini-commands` (engine SKILLs
 * remain in place via the dual-mode "Invocation modes" fallback). This
 * closes the slash-command UX gap for Gemini CLI (Codex CLI is covered by
 * the engine SKILL dual-mode procedure itself).
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

  // Place a `.gitkeep` in each data directory so an empty workspace survives
  // the user's first `git add .`. AGENTS.md's "データ管理ポリシー" recommends
  // committing these directories (state preservation across scheduled runs,
  // audit trail), which is impossible without a tracked placeholder file.
  //
  // Always create when missing, regardless of `--force` — a 0-byte placeholder
  // has no user content worth protecting. Existing `.gitkeep` files (or any
  // other content the user may have placed at that path) are left untouched
  // to avoid surprising overwrites.
  for (const dir of GITKEEP_DIRS) {
    const gitkeepPath = join(cwd, dir, ".gitkeep");
    if (await pathExists(gitkeepPath)) {
      continue;
    }
    await writeFile(gitkeepPath, "", "utf8");
    copiedFiles.push(`${dir}/.gitkeep`);
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

  if (!options.noGeminiCommands) {
    const geminiCommandsRoot = options.geminiCommandsRoot ?? (await resolveGeminiCommandsRoot());

    for (const command of GEMINI_COMMANDS) {
      const src = join(geminiCommandsRoot, `${command}.toml`);
      const destDir = join(cwd, ".gemini", "commands");
      const dest = join(destDir, `${command}.toml`);
      await mkdir(destDir, { recursive: true });

      if (!(await pathExists(src))) {
        warn(`init: bundled gemini command not found, skipped: ${src}`);
        skippedFiles.push(`.gemini/commands/${command}.toml`);
        continue;
      }

      if ((await pathExists(dest)) && !force) {
        warn(
          `init: skipped existing file (use --force to overwrite): .gemini/commands/${command}.toml`,
        );
        skippedFiles.push(`.gemini/commands/${command}.toml`);
        continue;
      }

      await copyFile(src, dest);
      copiedFiles.push(`.gemini/commands/${command}.toml`);
    }
  }

  if (!options.noAgentsMd) {
    await emitScaffold({
      cwd,
      force,
      templatesRoot: options.templatesRoot,
      scaffold: AGENTS_MD_SCAFFOLD,
      copiedFiles,
      skippedFiles,
      warn,
    });
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
  noGeminiCommands: boolean;
  noAgentsMd: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let force = false;
  let withRoutines = false;
  let withActions = false;
  let noClaudeSkills = false;
  let noGeminiCommands = false;
  let noAgentsMd = false;
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
    } else if (arg === "--no-gemini-commands") {
      noGeminiCommands = true;
    } else if (arg === "--no-agents-md") {
      noAgentsMd = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    }
  }
  return { force, withRoutines, withActions, noClaudeSkills, noGeminiCommands, noAgentsMd, help };
}

export const initCommand: Command = {
  name: "init",
  summary: "Initialize a workspace (sources/items/state/research/templates)",
  run: async (args) => {
    const { force, withRoutines, withActions, noClaudeSkills, noGeminiCommands, noAgentsMd, help } =
      parseArgs(args);
    if (help) {
      console.log("Usage: agentic-watch init [--force] [--with-routines] [--with-actions]");
      console.log(
        "                          [--no-claude-skills] [--no-gemini-commands] [--no-agents-md]",
      );
      console.log("");
      console.log("Creates the workspace directories and copies bundled skills:");
      console.log("  - Engine SKILLs (SSoT): .agents/skills/{research,review,update}/SKILL.md");
      console.log(
        "  - Claude Code slash-command wrappers: .claude/skills/{research,review,update,dismiss}/SKILL.md",
      );
      console.log(
        "  - Gemini CLI slash commands: .gemini/commands/{research,review,update,dismiss}.toml",
      );
      console.log(
        "  - Agent-agnostic instructions: AGENTS.md (auto-read by Codex / Gemini / Copilot)",
      );
      console.log("");
      console.log("Options:");
      console.log("  --force                Overwrite existing files");
      console.log(
        "  --with-routines        Generate claude/routines/watch-daily.md (Claude Routines scaffold)",
      );
      console.log(
        "  --with-actions         Generate .github/workflows/watch.yaml (GitHub Actions cron scaffold)",
      );
      console.log(
        "  --no-claude-skills     Skip writing slash-command wrappers to .claude/skills/",
      );
      console.log(
        "                         (useful if @ozzylabs/skills Renovate preset manages that directory)",
      );
      console.log(
        "  --no-gemini-commands   Skip writing Gemini CLI slash commands to .gemini/commands/",
      );
      console.log(
        "                         (engine SKILLs still serve interactive Gemini via dual-mode)",
      );
      console.log("  --no-agents-md         Skip writing AGENTS.md at the workspace root");
      console.log(
        "                         (useful if the workspace already has its own AGENTS.md)",
      );
      return 0;
    }
    await initWorkspace({
      cwd: process.cwd(),
      force,
      withRoutines,
      withActions,
      noClaudeSkills,
      noGeminiCommands,
      noAgentsMd,
    });
    return 0;
  },
};
