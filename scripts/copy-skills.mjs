#!/usr/bin/env node
// Copies bundled assets that tsc does not handle:
//   - src/skills/**/*.md            -> dist/skills/           (engine SSoT, .agents/skills/)
//   - src/templates/**              -> dist/templates/        (schedule scaffolds for init)
//   - src/claude-skills/**/*.md     -> dist/claude-skills/    (Claude Code slash command wrappers, .claude/skills/)
//   - src/gemini-commands/**/*.toml -> dist/gemini-commands/  (Gemini CLI slash commands, .gemini/commands/)

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
    // Allow directories so cp can recurse; otherwise restrict to .md / .yaml / .toml.
    filter: (p) => {
      try {
        if (!/\.[^./\\]+$/.test(p)) return true;
        return p.endsWith(".md") || p.endsWith(".yaml") || p.endsWith(".toml");
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
}

main().catch((err) => {
  console.error("copy-skills failed:", err);
  process.exit(1);
});
