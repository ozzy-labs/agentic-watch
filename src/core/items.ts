import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Item } from "../schemas/index.js";
import { ItemSchema } from "../schemas/index.js";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the on-disk filename for an item.
 *
 * Each item is stored as `items/<sourceId>/<itemId>.yaml`. Grouping by source
 * keeps the directory listing manageable for users running dozens of sources
 * and aligns with how `source remove` preserves history under
 * `items/<sourceId>/` (see issue #12).
 */
function itemFile(itemsDir: string, sourceId: string, itemId: string): string {
  return join(itemsDir, sourceId, `${itemId}.yaml`);
}

/**
 * Load all items under `items/<sourceId>/` and return them parsed + validated.
 *
 * Malformed files surface as thrown errors with the offending filename so
 * tooling can pinpoint the issue. Callers that want a fault-tolerant scan
 * should wrap the call in try/catch per file.
 */
export async function loadItems(itemsDir: string, sourceId?: string): Promise<Item[]> {
  if (!(await pathExists(itemsDir))) return [];
  const out: Item[] = [];
  const sourceDirs = sourceId ? [sourceId] : await readdir(itemsDir);
  for (const sid of sourceDirs) {
    const dir = join(itemsDir, sid);
    if (!(await pathExists(dir))) continue;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".yaml")) continue;
      const raw = await readFile(join(dir, entry), "utf8");
      const parsed = parseYaml(raw);
      const result = ItemSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `loadItems: schema mismatch in ${sid}/${entry}: ${result.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      out.push(result.data);
    }
  }
  return out;
}

/**
 * Persist items as YAML files under `items/<sourceId>/<itemId>.yaml`.
 *
 * Existing files for the same id are overwritten — callers are responsible
 * for de-duplication via the `state.lastSeenIds` cursor before invoking this.
 * The watcher uses this only for newly-detected items, so the overwrite path
 * is effectively unreachable in normal operation; we still leave it permissive
 * to keep the function idempotent under retry.
 */
export async function saveItems(itemsDir: string, items: Item[]): Promise<void> {
  for (const item of items) {
    const validated = ItemSchema.parse(item);
    const dir = join(itemsDir, validated.sourceId);
    await mkdir(dir, { recursive: true });
    const file = itemFile(itemsDir, validated.sourceId, validated.id);
    await writeFile(file, stringifyYaml(validated), "utf8");
  }
}
