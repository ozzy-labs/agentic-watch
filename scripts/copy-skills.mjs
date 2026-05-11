#!/usr/bin/env node
// Copies src/skills/**/*.md to dist/skills/ preserving directory structure.
// tsc does not copy non-TS assets, so we run this after `tsc` build.

import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const srcSkills = resolve(repoRoot, "src/skills");
const distSkills = resolve(repoRoot, "dist/skills");

async function main() {
  await rm(distSkills, { recursive: true, force: true });
  await mkdir(distSkills, { recursive: true });
  // Recursive copy; filter to only include .md files.
  await cp(srcSkills, distSkills, {
    recursive: true,
    filter: (src) => {
      // Always allow directories so cp can recurse into them.
      // Files are filtered to .md only.
      try {
        // Use the path-based heuristic: directories have no extension marker.
        return !/\.[^./\\]+$/.test(src) || src.endsWith(".md");
      } catch {
        return false;
      }
    },
  });
  console.log(`copy-skills: copied src/skills -> dist/skills`);
}

main().catch((err) => {
  console.error("copy-skills failed:", err);
  process.exit(1);
});
