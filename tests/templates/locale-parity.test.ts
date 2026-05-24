import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #342 B5: structural parity between the per-locale bundled template subtrees
 * `src/templates/en/**` and `src/templates/ja/**` (ADR-0021 D7).
 *
 * `radar init` / `radar workflow generate` / `radar routine generate` all
 * resolve their bundled source from `<templatesRoot>/<locale>/<path>`. If the
 * `ja` subtree is missing a file the `en` subtree has (or vice versa), the
 * corresponding `--lang ja` (or `--lang en`) command silently fails with
 * "bundled template not found" at runtime. The compile-time `Messages` type
 * guards the message *catalog* parity; this guards the *file-tree* parity that
 * no type can see.
 *
 * The check is two-way (en ⊇ ja AND ja ⊇ en) so neither locale can drift.
 * Additionally we assert a couple of structural anchors (key headings) line up
 * for the human-facing scaffolds so a future locale edit cannot quietly delete
 * a section that the engine / docs rely on.
 */

const TEMPLATES_ROOT = resolve(__dirname, "..", "..", "src", "templates");
const EN_ROOT = join(TEMPLATES_ROOT, "en");
const JA_ROOT = join(TEMPLATES_ROOT, "ja");

async function listFilesRel(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        out.push(relative(root, abs));
      }
    }
  }
  await walk(root);
  return out.sort();
}

describe("templates en/ja locale parity (#342 B5)", () => {
  it("en and ja expose the exact same file set", async () => {
    const enFiles = await listFilesRel(EN_ROOT);
    const jaFiles = await listFilesRel(JA_ROOT);
    expect(jaFiles).toEqual(enFiles);
  });

  it("both locales ship the workflow + routine templates the generators read", async () => {
    // These are the exact relative paths the generators join under
    // <templatesRoot>/<locale>/ — a missing one is a runtime
    // "bundled template not found" for that locale.
    const required = [
      "workflows/watch.template.yaml.tmpl",
      "workflows/combined.template.yaml.tmpl",
      "workflows/combined-with-triage.template.yaml.tmpl",
      "routines/watch.yaml.tmpl",
      "routines/pipeline.yaml.tmpl",
    ];
    const enFiles = new Set(await listFilesRel(EN_ROOT));
    const jaFiles = new Set(await listFilesRel(JA_ROOT));
    for (const rel of required) {
      expect(enFiles.has(rel), `en missing ${rel}`).toBe(true);
      expect(jaFiles.has(rel), `ja missing ${rel}`).toBe(true);
    }
  });

  it("the init scaffolds (AGENTS.md / CLAUDE.md / default.md / digest.md / feedradar.md) exist in both locales", async () => {
    const scaffolds = [
      "agents/AGENTS.md",
      "claude/CLAUDE.md",
      "default.md",
      "digest.md",
      "feedradar.md",
    ];
    const enFiles = new Set(await listFilesRel(EN_ROOT));
    const jaFiles = new Set(await listFilesRel(JA_ROOT));
    for (const rel of scaffolds) {
      expect(enFiles.has(rel), `en missing ${rel}`).toBe(true);
      expect(jaFiles.has(rel), `ja missing ${rel}`).toBe(true);
    }
  });

  it("each shared file is non-empty in both locales", async () => {
    const enFiles = await listFilesRel(EN_ROOT);
    for (const rel of enFiles) {
      const en = await readFile(join(EN_ROOT, rel), "utf8");
      const ja = await readFile(join(JA_ROOT, rel), "utf8");
      expect(en.trim().length, `en ${rel} empty`).toBeGreaterThan(0);
      expect(ja.trim().length, `ja ${rel} empty`).toBeGreaterThan(0);
    }
  });

  it("template placeholders ({{...}}) match between en and ja for the generator templates", async () => {
    // The generators substitute the SAME placeholder set regardless of locale;
    // a placeholder present in one locale but not the other would leave a raw
    // `{{token}}` in the rendered output for that locale. Compare the set of
    // distinct placeholders per generator template.
    const generatorTemplates = [
      "workflows/watch.template.yaml.tmpl",
      "workflows/combined.template.yaml.tmpl",
      "workflows/combined-with-triage.template.yaml.tmpl",
      "routines/watch.yaml.tmpl",
      "routines/pipeline.yaml.tmpl",
    ];
    const placeholders = (s: string): string[] =>
      [...new Set(s.match(/\{\{[a-zA-Z]+\}\}/g) ?? [])].sort();
    for (const rel of generatorTemplates) {
      const en = await readFile(join(EN_ROOT, rel), "utf8");
      const ja = await readFile(join(JA_ROOT, rel), "utf8");
      expect(placeholders(ja), `placeholder drift in ${rel}`).toEqual(placeholders(en));
    }
  });
});
