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

/**
 * Apply a FIFO (keep-newest) cap to a `lastSeenIds` list.
 *
 * `lastSeenIds` is append-only at the persistence layer: new ids are pushed to
 * the *end* and already-seen ids keep their original position (re-adding to a
 * `Set` does not move them), so the array is ordered oldest-first. When `max`
 * is a positive integer and the list exceeds it, we keep the trailing `max`
 * entries (the most recently appended ids) and drop the oldest from the front.
 *
 * This is safe for the facet-sweep firehose (ADR-0017) that motivated the cap:
 * facets are walked publishedAt-descending, so an id old enough to fall out of
 * the trailing window is very unlikely to reappear in a later sweep. If it
 * somehow does, the worst case is re-emitting one already-seen item — not data
 * loss.
 *
 * `max` undefined / non-positive disables the cap and returns the input
 * unchanged (existing source YAMLs that omit `maxSeenIds` keep their current
 * unbounded behavior).
 */
export function capSeenIds(ids: string[], max?: number): string[] {
  if (max === undefined || !Number.isInteger(max) || max <= 0) return ids;
  if (ids.length <= max) return ids;
  return ids.slice(ids.length - max);
}

/** Persist a source's state, creating the directory if needed. */
export async function saveSourceState(stateDir: string, state: SourceState): Promise<void> {
  const validated = SourceStateSchema.parse(state);
  const file = stateFile(stateDir, validated.sourceId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(validated), "utf8");
}
