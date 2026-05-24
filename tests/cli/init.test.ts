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
    workdir = await mkdtemp(join(tmpdir(), "feedradar-init-"));
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

  describe(".gitkeep placeholders in data directories", () => {
    // AGENTS.md "データ管理ポリシー" recommends committing sources/ items/
    // state/ research/ to git, but git does not track empty directories, so
    // an `init` + `git add .` workflow would lose the layout without a
    // tracked placeholder. `templates/` is intentionally excluded — bundled
    // template files (e.g. `default.md`) ship via a separate codepath and
    // serve as their own placeholder.

    it("emits .gitkeep in sources/items/state/research by default", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      for (const dir of ["sources", "items", "state", "research"]) {
        const gitkeep = join(workdir, dir, ".gitkeep");
        expect(await pathExists(gitkeep)).toBe(true);
        // The placeholder is intentionally a 0-byte file.
        expect((await readFile(gitkeep, "utf8")).length).toBe(0);
        expect(result.copiedFiles).toContain(`${dir}/.gitkeep`);
      }
    });

    it("does NOT emit .gitkeep in templates/ (owned by template bundling)", async () => {
      await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await pathExists(join(workdir, "templates", ".gitkeep"))).toBe(false);
    });

    it("does not overwrite existing .gitkeep (no surprising touch)", async () => {
      const gitkeep = join(workdir, "sources", ".gitkeep");
      await mkdir(join(workdir, "sources"), { recursive: true });
      await writeFile(gitkeep, "user marker", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      // The pre-existing content should be preserved verbatim.
      expect(await readFile(gitkeep, "utf8")).toBe("user marker");
      expect(result.copiedFiles).not.toContain("sources/.gitkeep");
      // The other 3 .gitkeep files should still land normally.
      for (const dir of ["items", "state", "research"]) {
        expect(await pathExists(join(workdir, dir, ".gitkeep"))).toBe(true);
        expect(result.copiedFiles).toContain(`${dir}/.gitkeep`);
      }
    });

    it("does not overwrite existing .gitkeep even with --force", async () => {
      // 0-byte placeholders have no user content worth protecting, but the
      // policy is to leave any existing file at that path untouched (whatever
      // its content) to avoid surprising overwrites of user markers.
      const gitkeep = join(workdir, "items", ".gitkeep");
      await mkdir(join(workdir, "items"), { recursive: true });
      await writeFile(gitkeep, "user marker", "utf8");

      await initWorkspace({
        cwd: workdir,
        force: true,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await readFile(gitkeep, "utf8")).toBe("user marker");
    });
  });

  it("copies bundled SKILL.md files into .agents/skills/<name>/", async () => {
    // Scope this test to the engine SKILLs only — claude discovery skills,
    // gemini commands, AGENTS.md, CLAUDE.md, templates/default.md, and
    // FEEDRADAR.md get their own describe blocks below.
    const result = await initWorkspace({
      cwd: workdir,
      force: false,
      skillsRoot: BUNDLED_SKILLS_ROOT,
      noClaudeSkills: true,
      noGeminiCommands: true,
      noAgentsMd: true,
      noClaudeMd: true,
      noTemplates: true,
      noFeedradarMd: true,
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
    // 3 engine SKILLs + 4 .gitkeep placeholders (sources/items/state/research).
    expect(result.copiedFiles).toHaveLength(7);
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
      expect(await pathExists(join(workdir, ".claude", "routines", "watch-daily.yaml"))).toBe(
        false,
      );
      expect(await pathExists(join(workdir, ".github", "workflows", "watch.yaml"))).toBe(false);
    });

    it("--with-routines emits .claude/routines/watch-daily.yaml", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        withRoutines: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });
      const dest = join(workdir, ".claude", "routines", "watch-daily.yaml");
      expect(await pathExists(dest)).toBe(true);
      const body = await readFile(dest, "utf8");
      // Sanity: scaffold is the bundled YAML template (Web-UI 1:1 fields,
      // ADR-0004 link, no MD frontmatter). #281 migrated this from the old
      // `claude/routines/watch-daily.md` MD scaffold.
      expect(body).not.toMatch(/^---/);
      expect(body).toMatch(/^name: watch-daily$/m);
      expect(body).toMatch(/cron: "0 0 \* \* \*"/);
      expect(body).toContain("ADR-0004");
      expect(result.copiedFiles).toContain(".claude/routines/watch-daily.yaml");
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
      expect(await pathExists(join(workdir, ".claude", "routines", "watch-daily.yaml"))).toBe(true);
      expect(await pathExists(join(workdir, ".github", "workflows", "watch.yaml"))).toBe(true);
      expect(result.copiedFiles).toContain(".claude/routines/watch-daily.yaml");
      expect(result.copiedFiles).toContain(".github/workflows/watch.yaml");
    });

    it("protects existing scaffold files without --force", async () => {
      const dest = join(workdir, ".claude", "routines", "watch-daily.yaml");
      await mkdir(join(workdir, ".claude", "routines"), { recursive: true });
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
      expect(result.skippedFiles).toContain(".claude/routines/watch-daily.yaml");
      expect(warnings.some((m) => m.includes(".claude/routines/watch-daily.yaml"))).toBe(true);
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
      expect(await pathExists(join(workdir, ".claude", "routines", "watch-daily.yaml"))).toBe(
        false,
      );
      expect(result.skippedFiles).toContain(".claude/routines/watch-daily.yaml");
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
        expect(body).toContain("radar");
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
        expect(body).toContain("radar");
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
      expect(body).toContain("radar dismiss");
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
      expect(body).toContain("radar");
      expect(body).toContain("research");
      expect(body).toContain("review");
      expect(body).toContain("update");
      expect(body).toContain("dismiss");
    });
  });

  describe("claude.md (workspace-root CLAUDE.md re-exporting AGENTS.md)", () => {
    // Without CLAUDE.md, Claude Code does not auto-read AGENTS.md, so the
    // industry-standard "SSoT in AGENTS.md, imported by CLAUDE.md" pattern
    // breaks. Default-on at workspace root; opt-out via `noClaudeMd`. Also
    // auto-skipped when `noAgentsMd` is true to avoid a dangling import.

    it("emits <cwd>/CLAUDE.md by default with @AGENTS.md import", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const dest = join(workdir, "CLAUDE.md");
      expect(await pathExists(dest)).toBe(true);
      const body = await readFile(dest, "utf8");
      expect(body).toContain("# CLAUDE.md");
      // The minimal template re-exports AGENTS.md so Claude Code reads it.
      expect(body).toContain("@AGENTS.md");
      expect(result.copiedFiles).toContain("CLAUDE.md");
    });

    it("skips CLAUDE.md when noClaudeMd: true", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noClaudeMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await pathExists(join(workdir, "CLAUDE.md"))).toBe(false);
      const claudeEntries = [...result.copiedFiles, ...result.skippedFiles].filter(
        (p) => p === "CLAUDE.md",
      );
      expect(claudeEntries).toEqual([]);
    });

    it("auto-skips CLAUDE.md when noAgentsMd: true (with warning)", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await pathExists(join(workdir, "CLAUDE.md"))).toBe(false);
      expect(await pathExists(join(workdir, "AGENTS.md"))).toBe(false);
      expect(result.skippedFiles).toContain("CLAUDE.md");
      // Warning should mention the dangling-import rationale.
      expect(warnings.some((m) => m.includes("CLAUDE.md") && m.includes("--no-agents-md"))).toBe(
        true,
      );
    });

    it("protects existing CLAUDE.md without --force", async () => {
      const dest = join(workdir, "CLAUDE.md");
      await writeFile(dest, "user-edited claude instructions", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await readFile(dest, "utf8")).toBe("user-edited claude instructions");
      expect(result.skippedFiles).toContain("CLAUDE.md");
      expect(warnings.some((m) => m.includes("CLAUDE.md"))).toBe(true);
    });

    it("overwrites existing CLAUDE.md with --force", async () => {
      const dest = join(workdir, "CLAUDE.md");
      await writeFile(dest, "user-edited claude instructions", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: true,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(dest, "utf8");
      expect(body).not.toBe("user-edited claude instructions");
      expect(body).toContain("@AGENTS.md");
      expect(result.copiedFiles).toContain("CLAUDE.md");
    });
  });

  describe("templates/default.md (starter report template)", () => {
    // The starter template seeds <cwd>/templates/default.md with a body
    // that mirrors the engine `research` SKILL fallback structure
    // (要約 / 詳細 / 出典). The research engine SKILL falls back to its
    // built-in structure when templateBody is empty, so skipping doesn't
    // break runtime behavior — it only removes the first editable artifact.

    it("emits <cwd>/templates/default.md by default", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const dest = join(workdir, "templates", "default.md");
      expect(await pathExists(dest)).toBe(true);
      expect(result.copiedFiles).toContain("templates/default.md");
    });

    it("skips templates/default.md when noTemplates: true", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        noTemplates: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      // The templates/ directory itself is still created (WORKSPACE_DIRS),
      // but default.md should not be written.
      expect(await pathExists(join(workdir, "templates"))).toBe(true);
      expect(await pathExists(join(workdir, "templates", "default.md"))).toBe(false);
      const templateEntries = [...result.copiedFiles, ...result.skippedFiles].filter(
        (p) => p === "templates/default.md",
      );
      expect(templateEntries).toEqual([]);
    });

    it("protects existing templates/default.md without --force", async () => {
      await mkdir(join(workdir, "templates"), { recursive: true });
      const dest = join(workdir, "templates", "default.md");
      await writeFile(dest, "user-edited template", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await readFile(dest, "utf8")).toBe("user-edited template");
      expect(result.skippedFiles).toContain("templates/default.md");
      expect(warnings.some((m) => m.includes("templates/default.md"))).toBe(true);
    });

    it("overwrites existing templates/default.md with --force", async () => {
      await mkdir(join(workdir, "templates"), { recursive: true });
      const dest = join(workdir, "templates", "default.md");
      await writeFile(dest, "user-edited template", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: true,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(dest, "utf8");
      expect(body).not.toBe("user-edited template");
      expect(result.copiedFiles).toContain("templates/default.md");
    });

    it("default.md mirrors the research SKILL fallback structure (no frontmatter)", async () => {
      await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(join(workdir, "templates", "default.md"), "utf8");
      // Template body only — frontmatter is constructed by the engine SKILL
      // per ADR-0003, so the bundled template must not start with `---`.
      expect(body).not.toMatch(/^---/);
      // Mirrors the engine `research` SKILL fallback structure
      // (src/skills/research/SKILL.md §3): 要約 / 詳細 / 出典.
      // Placeholders are wrapped in backticks (code spans) so the template
      // passes markdownlint MD033 (no inline HTML) while keeping the
      // "fill these in" intent visible to the editing user.
      expect(body).toContain("# `<Title>`");
      expect(body).toContain("## 要約");
      expect(body).toContain("## 詳細");
      expect(body).toContain("## 出典");
    });
  });

  describe("templates/digest.md (multi-item digest starter template)", () => {
    // ADR-0011 (digest research output): bundles the default digest template
    // and distributes it via `radar init` under the same `--no-templates`
    // umbrella as `default.md`. The body instructs the agent to bundle
    // multiple items into a single research report with sections for
    // per-item summaries, common themes, differences, and recommended
    // actions. Like default.md, it stores the body only (no frontmatter)
    // because the CLI constructs `ResearchFrontmatter` per ADR-0003 / 0011.

    it("emits <cwd>/templates/digest.md by default", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const dest = join(workdir, "templates", "digest.md");
      expect(await pathExists(dest)).toBe(true);
      expect(result.copiedFiles).toContain("templates/digest.md");
    });

    it("skips templates/digest.md when noTemplates: true (same umbrella as default.md)", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        noTemplates: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      // Both default.md and digest.md are gated by the same flag.
      expect(await pathExists(join(workdir, "templates", "default.md"))).toBe(false);
      expect(await pathExists(join(workdir, "templates", "digest.md"))).toBe(false);
      const templateEntries = [...result.copiedFiles, ...result.skippedFiles].filter(
        (p) => p === "templates/digest.md" || p === "templates/default.md",
      );
      expect(templateEntries).toEqual([]);
    });

    it("protects existing templates/digest.md without --force", async () => {
      await mkdir(join(workdir, "templates"), { recursive: true });
      const dest = join(workdir, "templates", "digest.md");
      await writeFile(dest, "user-edited digest template", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await readFile(dest, "utf8")).toBe("user-edited digest template");
      expect(result.skippedFiles).toContain("templates/digest.md");
      expect(warnings.some((m) => m.includes("templates/digest.md"))).toBe(true);
    });

    it("overwrites existing templates/digest.md with --force", async () => {
      await mkdir(join(workdir, "templates"), { recursive: true });
      const dest = join(workdir, "templates", "digest.md");
      await writeFile(dest, "user-edited digest template", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: true,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(dest, "utf8");
      expect(body).not.toBe("user-edited digest template");
      expect(result.copiedFiles).toContain("templates/digest.md");
    });

    it("digest.md ships as body only (no frontmatter, per ADR-0003 / ADR-0011)", async () => {
      await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(join(workdir, "templates", "digest.md"), "utf8");
      // Body only — frontmatter is constructed by the CLI per ADR-0003 /
      // ADR-0011, so the bundled template must not start with `---`.
      expect(body).not.toMatch(/^---/);
      // ADR-0011 §Issue #139 suggested sections: per-item summaries,
      // common themes, differences, recommended actions.
      expect(body).toContain("## 要約");
      expect(body).toContain("## 各 item の要点");
      expect(body).toContain("## 共通テーマ");
      expect(body).toContain("## 差分");
      expect(body).toContain("## 推奨アクション");
      expect(body).toContain("## 出典");
      // ADR-0009 boundary marker (M1c) editorial guidance must be present
      // so users editing this template understand the untrusted-content
      // contract enforced by the prompt builder at runtime.
      expect(body).toContain("ADR-0009");
      expect(body).toContain("untrusted_item");
    });
  });

  describe("FEEDRADAR.md (human-facing workspace guide)", () => {
    // FEEDRADAR.md is the canonical entry point for the human who ran
    // init. Distinct from AGENTS.md / CLAUDE.md (AI-agent-facing). Same
    // warning+skip + --force overwrite policy as other bundled files.

    it("emits <cwd>/FEEDRADAR.md by default", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        noTemplates: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const dest = join(workdir, "FEEDRADAR.md");
      expect(await pathExists(dest)).toBe(true);
      const body = await readFile(dest, "utf8");
      expect(body).toContain("# FeedRadar workspace");
      // Body should advertise natural-language / slash usage as the primary
      // path (not CLI direct invocation).
      expect(body).toContain("自然言語");
      expect(body).toContain("/research");
      expect(result.copiedFiles).toContain("FEEDRADAR.md");
    });

    it("skips FEEDRADAR.md when noFeedradarMd: true", async () => {
      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        noTemplates: true,
        noFeedradarMd: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await pathExists(join(workdir, "FEEDRADAR.md"))).toBe(false);
      const entries = [...result.copiedFiles, ...result.skippedFiles].filter(
        (p) => p === "FEEDRADAR.md",
      );
      expect(entries).toEqual([]);
    });

    it("protects existing FEEDRADAR.md without --force", async () => {
      const dest = join(workdir, "FEEDRADAR.md");
      await writeFile(dest, "user-edited workspace docs", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        noTemplates: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      expect(await readFile(dest, "utf8")).toBe("user-edited workspace docs");
      expect(result.skippedFiles).toContain("FEEDRADAR.md");
      expect(warnings.some((m) => m.includes("FEEDRADAR.md"))).toBe(true);
    });

    it("overwrites existing FEEDRADAR.md with --force", async () => {
      const dest = join(workdir, "FEEDRADAR.md");
      await writeFile(dest, "user-edited workspace docs", "utf8");

      const result = await initWorkspace({
        cwd: workdir,
        force: true,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        noTemplates: true,
        warn: (m) => warnings.push(m),
        info: () => undefined,
      });

      const body = await readFile(dest, "utf8");
      expect(body).not.toBe("user-edited workspace docs");
      expect(body).toContain("# FeedRadar workspace");
      expect(result.copiedFiles).toContain("FEEDRADAR.md");
    });

    it("emits next-step hint to info sink when FEEDRADAR.md is written", async () => {
      const infoMessages: string[] = [];
      await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        noTemplates: true,
        warn: (m) => warnings.push(m),
        info: (m) => infoMessages.push(m),
      });

      expect(infoMessages.some((m) => m.includes("FEEDRADAR.md"))).toBe(true);
      expect(infoMessages.some((m) => m.includes("next steps"))).toBe(true);
    });

    it("does not emit next-step hint when FEEDRADAR.md is skipped", async () => {
      const infoMessages: string[] = [];
      await initWorkspace({
        cwd: workdir,
        force: false,
        skillsRoot: BUNDLED_SKILLS_ROOT,
        templatesRoot: BUNDLED_TEMPLATES_ROOT,
        noClaudeSkills: true,
        noGeminiCommands: true,
        noAgentsMd: true,
        noTemplates: true,
        noFeedradarMd: true,
        warn: (m) => warnings.push(m),
        info: (m) => infoMessages.push(m),
      });

      expect(infoMessages.some((m) => m.includes("next steps"))).toBe(false);
    });
  });
});
