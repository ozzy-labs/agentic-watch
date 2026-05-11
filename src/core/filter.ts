import type { Item, Source } from "../schemas/index.js";

export function filterItems(items: Item[], _source: Source): Item[] {
  // Phase 1 で keyword / excludeKeyword 判定を実装する。現状は素通し。
  return items;
}
