import type { Item, Source } from "../../schemas/index.js";

export interface FeedAdapter {
  kind: Source["kind"];
  fetch: (source: Source) => Promise<Item[]>;
}
