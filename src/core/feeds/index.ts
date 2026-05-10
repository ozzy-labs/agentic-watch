import type { Source } from "../../schemas/index.js";
import { githubReleasesAdapter } from "./github-releases.js";
import { htmlAdapter } from "./html.js";
import { npmRegistryAdapter } from "./npm-registry.js";
import { rssAdapter } from "./rss.js";
import type { FeedAdapter } from "./types.js";

const adapters = new Map<Source["kind"], FeedAdapter>([
  [rssAdapter.kind, rssAdapter],
  [htmlAdapter.kind, htmlAdapter],
  [githubReleasesAdapter.kind, githubReleasesAdapter],
  [npmRegistryAdapter.kind, npmRegistryAdapter],
]);

export function getFeedAdapter(kind: Source["kind"]): FeedAdapter {
  const adapter = adapters.get(kind);
  if (!adapter) {
    throw new Error(`No feed adapter registered for kind: ${kind}`);
  }
  return adapter;
}

export type { FeedAdapter } from "./types.js";
