import type { Source } from "../../schemas/index.js";
import { githubReleasesAdapter } from "./github-releases.js";
import { htmlAdapter } from "./html.js";
import { htmlJsAdapter } from "./html-js.js";
import { npmRegistryAdapter } from "./npm-registry.js";
import { rssAdapter } from "./rss.js";
import type { FeedAdapter } from "./types.js";

const adapters = new Map<Source["kind"], FeedAdapter>([
  [rssAdapter.kind, rssAdapter],
  [htmlAdapter.kind, htmlAdapter],
  [htmlJsAdapter.kind, htmlJsAdapter],
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

export type { FeedAdapter, FeedAdapterOptions, FeedFetchResult, FetchLike } from "./types.js";
