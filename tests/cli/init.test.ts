import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../../src/cli/init.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const BUNDLED_SKILLS_ROOT = join(REPO_ROOT, "src", "skills");

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
    const result = await initWorkspace({
      cwd: workdir,
      force: false,
      skillsRoot: BUNDLED_SKILLS_ROOT,
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
});
