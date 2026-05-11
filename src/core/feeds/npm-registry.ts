import type { FeedAdapter } from "./types.js";

export const npmRegistryAdapter: FeedAdapter = {
  kind: "npm-registry",
  fetch: async (_source, _options) => {
    throw new Error("npm-registry adapter: not implemented yet (Phase 3)");
  },
};
