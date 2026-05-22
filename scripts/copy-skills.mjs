#!/usr/bin/env node
// Copies bundled assets that tsc does not handle:
//   - src/skills/**/*.md            -> dist/skills/           (engine SSoT, .agents/skills/)
//   - src/templates/**              -> dist/templates/        (schedule scaffolds for init)
//   - src/claude-skills/**/*.md     -> dist/claude-skills/    (Claude Code slash command wrappers, .claude/skills/)
//   - src/gemini-commands/**/*.toml -> dist/gemini-commands/  (Gemini CLI slash commands, .gemini/commands/)
//   - recipes/**/*.yaml             -> dist/recipes/          (bundled JSON-API recipes, ADR-0012 §D3)

import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

async function copyMdTree(srcRel, distRel, label) {
  const src = resolve(repoRoot, srcRel);
  const dist = resolve(repoRoot, distRel);
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(src, dist, {
    recursive: true,
    // Allow directories so cp can recurse; otherwise restrict to bundled
    // asset extensions. `.tmpl` is included for workflow placeholder
    // templates (e.g. `watch.template.yaml.tmpl`) that intentionally hold
    // pre-substitution syntax and are stored with a non-`.yaml` extension
    // to escape repo-wide yamlfmt — see ADR-0014 / #188.
    filter: (p) => {
      try {
        if (!/\.[^./\\]+$/.test(p)) return true;
        return (
          p.endsWith(".md") ||
          p.endsWith(".yaml") ||
          p.endsWith(".toml") ||
          p.endsWith(".tmpl")
        );
      } catch {
        return false;
      }
    },
  });
  console.log(`copy-skills: copied ${srcRel} -> ${distRel} (${label})`);
}

async function main() {
  await copyMdTree("src/skills", "dist/skills", "skills");
  await copyMdTree("src/templates", "dist/templates", "init templates");
  await copyMdTree("src/claude-skills", "dist/claude-skills", "claude discovery skills");
  await copyMdTree("src/gemini-commands", "dist/gemini-commands", "gemini commands");
  // recipes/ lives at the package root rather than under src/ so users can
  // browse it on GitHub without descending into src/. ADR-0012 §D3 (strategy
  // A — bundled recipes) requires the directory to ship with the npm
  // package; this copy step puts a runtime-accessible copy at
  // dist/recipes/ that resolveRecipesRoot() in src/core/recipes.ts probes
  // first.
  await copyMdTree("recipes", "dist/recipes", "bundled recipes");
}

main().catch((err) => {
  console.error("copy-skills failed:", err);
  process.exit(1);
});
