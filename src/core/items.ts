import type { Item } from "../schemas/index.js";

export async function loadItems(_dir: string): Promise<Item[]> {
  throw new Error("loadItems: not implemented yet (Phase 1)");
}

export async function saveItems(_dir: string, _items: Item[]): Promise<void> {
  throw new Error("saveItems: not implemented yet (Phase 1)");
}
