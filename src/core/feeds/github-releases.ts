import type { FeedAdapter } from "./types.js";

export const githubReleasesAdapter: FeedAdapter = {
  kind: "github-releases",
  fetch: async (_source, _options) => {
    throw new Error("github-releases adapter: not implemented yet (Phase 3)");
  },
};
