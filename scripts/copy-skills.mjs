#!/usr/bin/env node
// Copies bundled assets that tsc does not handle:
//   - src/skills/**/*.md  -> dist/skills/
//   - src/templates/**    -> dist/templates/  (schedule scaffolds for init)

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
    // Allow directories so cp can recurse; otherwise restrict to .md / .yaml.
    filter: (p) => {
      try {
        if (!/\.[^./\\]+$/.test(p)) return true;
        return p.endsWith(".md") || p.endsWith(".yaml");
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
}

main().catch((err) => {
  console.error("copy-skills failed:", err);
  process.exit(1);
});
