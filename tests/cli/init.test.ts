import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../../src/cli/init.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const BUNDLED_SKILLS_ROOT = join(REPO_ROOT, "src", "skills");
const BUNDLED_TEMPLATES_ROOT = join(REPO_ROOT, "src", "templates");
const BUNDLED_CLAUDE_SKILLS_ROOT = join(REPO_ROOT, "src", "claude-skills");

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
    // Scope this test to the engine SKILLs only — claude discovery skills get
    // their own describe block below.
    const result = await initWorkspace({
      cwd: workdir,
      force: false,
      skillsRoot: BUNDLED_SKILLS_ROOT,
      noClaudeSkills: true,
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
});
