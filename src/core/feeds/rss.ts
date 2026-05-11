import type { FeedAdapter } from "./types.js";

export const rssAdapter: FeedAdapter = {
  kind: "rss",
  fetch: async (_source) => {
    throw new Error("rss adapter: not implemented yet (Phase 1)");
  },
};
