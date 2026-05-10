import type { Item, Source } from "../schemas/index.js";
import { getFeedAdapter } from "./feeds/index.js";

export async function watch(sources: Source[]): Promise<Item[]> {
  const results: Item[] = [];
  for (const source of sources) {
    const adapter = getFeedAdapter(source.kind);
    const items = await adapter.fetch(source);
    results.push(...items);
  }
  return results;
}
