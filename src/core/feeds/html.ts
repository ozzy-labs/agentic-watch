import type { FeedAdapter } from "./types.js";

export const htmlAdapter: FeedAdapter = {
  kind: "html",
  fetch: async (_source) => {
    throw new Error("html adapter: not implemented yet (Phase 3)");
  },
};
