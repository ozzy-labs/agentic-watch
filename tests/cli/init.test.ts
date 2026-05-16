import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../../src/cli/init.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const BUNDLED_SKILLS_ROOT = join(REPO_ROOT, "src", "skills");
const BUNDLED_TEMPLATES_ROOT = join(REPO_ROOT, "src", "templates");
const BUNDLED_CLAUDE_SKILLS_ROOT = join(REPO_ROOT, "src", "claude-skills");
const BUNDLED_GEMINI_COMMANDS_ROOT = join(REPO_ROOT, "src", "gemini-commands");

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("cli/init", () => {
  let workdir: string;
  let warnings: string[];

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "agentic-watch-init-"));
    warnings = [];
  });

  afterEach(() => {
    // mkdtemp dirs are cleaned by OS; no explicit rm to keep this test focused
    // on behavior under inspection rather than fs plumbing.
  });

  it("creates the canonical workspace directories", async () => {
    await initWorkspace({
      cwd: workdir,
      force: false,
      skillsRoot: BUNDLED_SKILLS_ROOT,
      warn: (m) => warnings.push(m),
      info: () => undefined,
    });

    for (const dir of ["sources", "state", "items", "research", "templates"]) {
      const abs = join(workdir, dir);
      expect(await pathExists(abs)).toBe(true);
      const s = await stat(abs);
      expect(s.isDirectory()).toBe(true);
    }
  });

  it("copies bundled SKILL.md files into .agents/skills/<name>/", async () => {
    // Scope this test to the engine SKILLs only — claude discovery skills,
    // gemini commands, and AGENTS.md get their own describe blocks below.
    const result = await initWorkspace({
      cwd: workdir,
      force: false,
      skillsRoot: BUNDLED_SKILLS_ROOT,
      noClaudeSkills: true,
      noGeminiCommands: true,
      noAgentsMd: true,
      warn: (m) => warnings.push(m),
      info: () => undefined,
    });

    for (const skill of ["research", "review", "update"]) {
      const dest = join(workdir, ".agents", "skills", skill, "SKILL.md");
      expect(await pathExists(dest)).toBe(true);
      const body = await readFile(dest, "utf8");
      expect(body).toMatch(/^---/);
      expect(body).toMatch(new RegExp(`name:\\s*${skill}`));
    }
    expect(result.copiedFiles).toHaveLength(3);
    expect(result.skippedFiles).toHaveLength(0);
  });

  it("protects existing files without --force (warning + skip)", async () => {
    const dest = join(workdir, ".agents", "skills", "research", "SKILL.md");
    await mkdir(join(workdir, ".agents", "skills", "research"), { recursive: true });
    await writeFile(dest, "user-edited content", "utf8");

    const result = await initWorkspace({
      cwd: workdir,
      force: false,
      skillsRoot: BUNDLED_SKILLS_ROOT,
      warn: (m) => warnings.push(m),
      info: () => undefined,
    });

    const body = await readFile(dest, "utf8");
    expect(body).toBe("user-edited content");
    expect(result.skippedFiles).toContain(".agents/skills/research/SKILL.md");
    expect(warnings.some((m) => m.includes("research/SKILL.md"))).toBe(true);
  });

  it("overwrites existing files with --force", async () => {
    const dest = join(workdir, ".agents", "skills", "review", "SKILL.md");
    await mkdir(join(workdir, ".agents", "skills", "review"), { recursive: true });
    await writeFile(dest, "user-edited content", "utf8");

    const result = await initWorkspace({
      cwd: workdir,
      force: true,
      skillsRoot: BUNDLED_SKILLS_ROOT,
      warn: (m) => warnings.push(m),
      info: () => undefined,
    });

    const body = await readFile(dest, "utf8");
    expect(body).not.toBe("user-edited content");
    expect(body).toMatch(/^---/);
    expect(result.copiedFiles).toContain(".agents/skills/review/SKILL.md");
  });

  it("is idempotent for directories (re-running does not error)", async () => {
    await initWorkspace({
      cwd: workdir,
      force: false,
      skillsRoot: BUNDLED_SKILLS_ROOT,
      warn: (m) => warnings.push(m),
      info: () => undefined,
    });
    await initWorkspace({
      cwd: workdir,
      force: false,
      skillsRoot: BUNDLED_SKILLS_ROOT,
      warn: (m) => warnings.push(m),
      info: () => undefined,
    });

    for (const dir of ["sources", "state", "items", "research", "templates"]) {
      expect(await pathExists(join(workdir, dir))).toBe(true);
    }
  });

  describe("schedule scaffolds (--with-routines / --with-actions)", () => {
    it("does NOT emit either scaffold by default", async () => {
      await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });
      expect(await pathExists(join(workdir, "claude", "routines", "watch-daily.md"))).toBe(false);
      expect(await pathExists(join(workdir, ".github", "workflows", "watch.yaml"))).toBe(false);
    });

    it("--with-routines emits claude/routines/watch-daily.md", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        withRoutines: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });
      const dest = join(workdir, "claude", "routines", "watch-daily.md");
      expect(await pathExists(dest)).toBe(true);
      const body = await readFile(dest, "utf8");
      // Sanity: scaffold is the bundled template (frontmatter + ADR-0004 link).
      expect(body).toMatch(/^---/);
      expect(body).toMatch(/schedule:/);
      expect(body).toContain("ADR-0004");
      expect(result.copiedFiles).toContain("claude/routines/watch-daily.md");
    });

    it("--with-actions emits .github/workflows/watch.yaml", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        withActions: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });
      const dest = join(workdir, ".github", "workflows", "watch.yaml");
      expect(await pathExists(dest)).toBe(true);
      const body = await readFile(dest, "utf8");
      // Sanity: scaffold is the bundled template (uses ANTHROPIC_API_KEY, not OAuth).
      expect(body).toContain("ANTHROPIC_API_KEY");
      expect(body).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(body).toContain("cron:");
      expect(result.copiedFiles).toContain(".github/workflows/watch.yaml");
    });

    it("emits both scaffolds when both flags are passed", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        withRoutines: true,
        withActions: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });
      expect(await pathExists(join(workdir, "claude", "routines", "watch-daily.md"))).toBe(true);
      expect(await pathExists(join(workdir, ".github", "workflows", "watch.yaml"))).toBe(true);
      expect(result.copiedFiles).toContain("claude/routines/watch-daily.md");
      expect(result.copiedFiles).toContain(".github/workflows/watch.yaml");
    });

    it("protects existing scaffold files without --force", async () => {
      const dest = join(workdir, "claude", "routines", "watch-daily.md");
      await mkdir(join(workdir, "claude", "routines"), { recursive: true });
      await writeFile(dest, "user-edited routine", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        withRoutines: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await readFile(dest, "utf8")).toBe("user-edited routine");
      expect(result.skippedFiles).toContain("claude/routines/watch-daily.md");
      expect(warnings.some((m) => m.includes("claude/routines/watch-daily.md"))).toBe(true);
    });

    it("overwrites existing scaffold files with --force", async () => {
      const dest = join(workdir, ".github", "workflows", "watch.yaml");
      await mkdir(join(workdir, ".github", "workflows"), { recursive: true });
      await writeFile(dest, "user-edited workflow", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: true,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        withActions: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(dest, "utf8");
      expect(body).not.toBe("user-edited workflow");
      expect(body).toContain("ANTHROPIC_API_KEY");
      expect(result.copiedFiles).toContain(".github/workflows/watch.yaml");
    });

    it("warns and records a skip when the bundled template is missing", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        // Point at a templates root that does not exist on disk.
        templatesRoot: join(workdir, "__nope__"),
        withRoutines: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });
      expect(await pathExists(join(workdir, "claude", "routines", "watch-daily.md"))).toBe(false);
      expect(result.skippedFiles).toContain("claude/routines/watch-daily.md");
      expect(warnings.some((m) => m.includes("bundled template not found"))).toBe(true);
    });
  });

  describe("claude discovery skills (.claude/skills/ slash-command wrappers)", () => {
    // These wrappers are distinct from the engine SKILLs at .agents/skills/.
    // ADR-0007 (revised 2026-05-17): default-on for Claude Code discoverability,
    // opt-out via `noClaudeSkills` for workspaces that already manage
    // .claude/skills/ via the @ozzylabs/skills Renovate preset.

    it("emits .claude/skills/{research,review,update,dismiss}/SKILL.md by default", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        claudeSkillsRoot: BUNDLED_CLAUDE_SKILLS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      for (const skill of ["research", "review", "update", "dismiss"]) {
        const dest = join(workdir, ".claude", "skills", skill, "SKILL.md");
        expect(await pathExists(dest)).toBe(true);
        const body = await readFile(dest, "utf8");
        // Slash-command frontmatter contract.
        expect(body).toMatch(new RegExp(`name:\\s*${skill}`));
        expect(body).toMatch(/description:/);
        expect(body).toMatch(/argument-hint:/);
        // The wrapper delegates to the CLI — body should reference it.
        expect(body).toContain("agentic-watch");
        expect(result.copiedFiles).toContain(`.claude/skills/${skill}/SKILL.md`);
      }
    });

    it("skips .claude/skills/ entirely when noClaudeSkills: true", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        claudeSkillsRoot: BUNDLED_CLAUDE_SKILLS_ROOT,
        noClaudeSkills: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      // The .claude/skills/ directory should not be touched at all.
      expect(await pathExists(join(workdir, ".claude", "skills"))).toBe(false);
      // Engine SKILLs are still written (this is the SSoT layer, always on).
      for (const skill of ["research", "review", "update"]) {
        expect(await pathExists(join(workdir, ".agents", "skills", skill, "SKILL.md"))).toBe(true);
      }
      // No .claude/skills/ entries in either copied or skipped (we never even
      // looked at the bundle).
      const claudeEntries = [...result.copiedFiles, ...result.skippedFiles].filter((p) =>
        p.startsWith(".claude/skills/"),
      );
      expect(claudeEntries).toEqual([]);
    });

    it("protects existing .claude/skills/<name>/SKILL.md without --force", async () => {
      const dest = join(workdir, ".claude", "skills", "research", "SKILL.md");
      await mkdir(join(workdir, ".claude", "skills", "research"), { recursive: true });
      await writeFile(dest, "user-edited slash command", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        claudeSkillsRoot: BUNDLED_CLAUDE_SKILLS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await readFile(dest, "utf8")).toBe("user-edited slash command");
      expect(result.skippedFiles).toContain(".claude/skills/research/SKILL.md");
      expect(warnings.some((m) => m.includes(".claude/skills/research/SKILL.md"))).toBe(true);
      // The other 3 discovery skills should still be written.
      for (const skill of ["review", "update", "dismiss"]) {
        expect(await pathExists(join(workdir, ".claude", "skills", skill, "SKILL.md"))).toBe(true);
      }
    });

    it("overwrites existing .claude/skills/<name>/SKILL.md with --force", async () => {
      const dest = join(workdir, ".claude", "skills", "dismiss", "SKILL.md");
      await mkdir(join(workdir, ".claude", "skills", "dismiss"), { recursive: true });
      await writeFile(dest, "user-edited slash command", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: true,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        claudeSkillsRoot: BUNDLED_CLAUDE_SKILLS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(dest, "utf8");
      expect(body).not.toBe("user-edited slash command");
      expect(body).toMatch(/^---/);
      expect(body).toMatch(/name:\s*dismiss/);
      expect(result.copiedFiles).toContain(".claude/skills/dismiss/SKILL.md");
    });

    it("warns and records a skip when the claude-skills bundle is missing", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        // Point at a discovery-skills root that does not exist on disk.
        claudeSkillsRoot: join(workdir, "__nope__"),
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      for (const skill of ["research", "review", "update", "dismiss"]) {
        expect(await pathExists(join(workdir, ".claude", "skills", skill, "SKILL.md"))).toBe(false);
        expect(result.skippedFiles).toContain(`.claude/skills/${skill}/SKILL.md`);
      }
      expect(warnings.some((m) => m.includes("bundled claude discovery skill not found"))).toBe(
        true,
      );
    });
  });

  describe("gemini commands (.gemini/commands/)", () => {
    // ADR-0007 (revised 2026-05-17 c via #78): default-on Gemini CLI slash
    // commands at <cwd>/.gemini/commands/<name>.toml, opt-out via
    // `noGeminiCommands` for workspaces that already manage that directory
    // or don't use Gemini CLI. Closes the slash-command UX gap for Gemini
    // CLI (Codex CLI is covered by the engine SKILL dual-mode procedure
    // itself; Claude / Copilot were already covered via .claude/skills/).

    it("emits .gemini/commands/{research,review,update,dismiss}.toml by default", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        claudeSkillsRoot: BUNDLED_CLAUDE_SKILLS_ROOT,
        geminiCommandsRoot: BUNDLED_GEMINI_COMMANDS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      for (const command of ["research", "review", "update", "dismiss"]) {
        const dest = join(workdir, ".gemini", "commands", `${command}.toml`);
        expect(await pathExists(dest)).toBe(true);
        const body = await readFile(dest, "utf8");
        // Gemini CLI command TOML contract: `prompt` and `description` keys.
        expect(body).toMatch(/^prompt\s*=/m);
        expect(body).toMatch(/^description\s*=/m);
        // The wrapper delegates to the CLI — body should reference it and
        // Gemini's {{args}} interpolation token.
        expect(body).toContain("agentic-watch");
        expect(body).toContain("{{args}}");
        expect(result.copiedFiles).toContain(`.gemini/commands/${command}.toml`);
      }
    });

    it("skips .gemini/commands/ entirely when noGeminiCommands: true", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        claudeSkillsRoot: BUNDLED_CLAUDE_SKILLS_ROOT,
        geminiCommandsRoot: BUNDLED_GEMINI_COMMANDS_ROOT,
        noGeminiCommands: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      // The .gemini/commands/ directory should not be touched at all.
      expect(await pathExists(join(workdir, ".gemini", "commands"))).toBe(false);
      // Engine SKILLs are still written (this is the SSoT layer, always on).
      for (const skill of ["research", "review", "update"]) {
        expect(await pathExists(join(workdir, ".agents", "skills", skill, "SKILL.md"))).toBe(true);
      }
      // No .gemini/commands/ entries in either copied or skipped (we never
      // even looked at the bundle).
      const geminiEntries = [...result.copiedFiles, ...result.skippedFiles].filter((p) =>
        p.startsWith(".gemini/commands/"),
      );
      expect(geminiEntries).toEqual([]);
    });

    it("protects existing .gemini/commands/<name>.toml without --force", async () => {
      const dest = join(workdir, ".gemini", "commands", "research.toml");
      await mkdir(join(workdir, ".gemini", "commands"), { recursive: true });
      await writeFile(dest, 'prompt = "user-edited"\ndescription = "user"\n', "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        claudeSkillsRoot: BUNDLED_CLAUDE_SKILLS_ROOT,
        geminiCommandsRoot: BUNDLED_GEMINI_COMMANDS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await readFile(dest, "utf8")).toBe('prompt = "user-edited"\ndescription = "user"\n');
      expect(result.skippedFiles).toContain(".gemini/commands/research.toml");
      expect(warnings.some((m) => m.includes(".gemini/commands/research.toml"))).toBe(true);
      // The other 3 commands should still be written.
      for (const command of ["review", "update", "dismiss"]) {
        expect(await pathExists(join(workdir, ".gemini", "commands", `${command}.toml`))).toBe(
          true,
        );
      }
    });

    it("overwrites existing .gemini/commands/<name>.toml with --force", async () => {
      const dest = join(workdir, ".gemini", "commands", "dismiss.toml");
      await mkdir(join(workdir, ".gemini", "commands"), { recursive: true });
      await writeFile(dest, 'prompt = "user-edited"\ndescription = "user"\n', "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: true,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        claudeSkillsRoot: BUNDLED_CLAUDE_SKILLS_ROOT,
        geminiCommandsRoot: BUNDLED_GEMINI_COMMANDS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(dest, "utf8");
      expect(body).not.toBe('prompt = "user-edited"\ndescription = "user"\n');
      expect(body).toMatch(/^prompt\s*=/m);
      expect(body).toContain("agentic-watch dismiss");
      expect(result.copiedFiles).toContain(".gemini/commands/dismiss.toml");
    });

    it("warns and records a skip when the gemini-commands bundle is missing", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        claudeSkillsRoot: BUNDLED_CLAUDE_SKILLS_ROOT,
        // Point at a gemini-commands root that does not exist on disk.
        geminiCommandsRoot: join(workdir, "__nope__"),
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      for (const command of ["research", "review", "update", "dismiss"]) {
        expect(await pathExists(join(workdir, ".gemini", "commands", `${command}.toml`))).toBe(
          false,
        );
        expect(result.skippedFiles).toContain(`.gemini/commands/${command}.toml`);
      }
      expect(warnings.some((m) => m.includes("bundled gemini command not found"))).toBe(true);
    });
  });

  describe("agents.md (workspace-root AGENTS.md for multi-agent context)", () => {
    // ADR-0007 (revised 2026-05-17 b via #77): default-on AGENTS.md at the
    // workspace root so that Codex CLI / Gemini CLI / Copilot CLI auto-read
    // workspace context. Opt-out via `noAgentsMd` for workspaces that already
    // have their own AGENTS.md.

    it("emits <cwd>/AGENTS.md by default", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const dest = join(workdir, "AGENTS.md");
      expect(await pathExists(dest)).toBe(true);
      expect(result.copiedFiles).toContain("AGENTS.md");
    });

    it("skips AGENTS.md when noAgentsMd: true", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await pathExists(join(workdir, "AGENTS.md"))).toBe(false);
      const agentsEntries = [...result.copiedFiles, ...result.skippedFiles].filter(
        (p) => p === "AGENTS.md",
      );
      expect(agentsEntries).toEqual([]);
    });

    it("protects existing AGENTS.md without --force", async () => {
      const dest = join(workdir, "AGENTS.md");
      await writeFile(dest, "user-edited agents instructions", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await readFile(dest, "utf8")).toBe("user-edited agents instructions");
      expect(result.skippedFiles).toContain("AGENTS.md");
      expect(warnings.some((m) => m.includes("AGENTS.md"))).toBe(true);
    });

    it("overwrites existing AGENTS.md with --force", async () => {
      const dest = join(workdir, "AGENTS.md");
      await writeFile(dest, "user-edited agents instructions", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: true,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(dest, "utf8");
      expect(body).not.toBe("user-edited agents instructions");
      expect(result.copiedFiles).toContain("AGENTS.md");
    });

    it("AGENTS.md content includes key commands and workspace context", async () => {
      await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(join(workdir, "AGENTS.md"), "utf8");
      // Sanity: the bundled template names the project and the main commands.
      expect(body).toContain("agentic-watch");
      expect(body).toContain("research");
      expect(body).toContain("review");
      expect(body).toContain("update");
      expect(body).toContain("dismiss");
    });
  });
});
