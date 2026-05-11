import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SourceState } from "../schemas/index.js";
import { SourceStateSchema } from "../schemas/index.js";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function stateFile(stateDir: string, sourceId: string): string {
  return join(stateDir, `${sourceId}.yaml`);
}

/**
 * Load a single source's state from `state/<sourceId>.yaml`.
 *
 * Returns an empty record (no `lastFetchedAt` / `lastEtag` and an empty
 * `lastSeenIds`) when the file does not exist, so callers can treat absence
 * as "fresh start" without branching.
 */
export async function loadSourceState(stateDir: string, sourceId: string): Promise<SourceState> {
  const file = stateFile(stateDir, sourceId);
  if (!(await pathExists(file))) {
    return { sourceId, lastSeenIds: [] };
  }
  const raw = await readFile(file, "utf8");
  const parsed = parseYaml(raw) as Record<string, unknown> | null;
  // Fill in sourceId if older files don't carry it (defensive).
  const candidate = { ...(parsed ?? {}), sourceId: parsed?.sourceId ?? sourceId };
  return SourceStateSchema.parse(candidate);
}

/** Persist a source's state, creating the directory if needed. */
export async function saveSourceState(stateDir: string, state: SourceState): Promise<void> {
  const validated = SourceStateSchema.parse(state);
  const file = stateFile(stateDir, validated.sourceId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(validated), "utf8");
}
