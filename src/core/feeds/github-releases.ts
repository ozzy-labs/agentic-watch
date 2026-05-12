import type { Item, Source } from "../../schemas/index.js";
import { ItemSchema } from "../../schemas/index.js";
import { deriveItemId, deriveStableKey } from "./derive-id.js";
import { fetchReleases, type GitHubRelease, parseOwnerRepo } from "./github-api.js";
import type { FeedAdapter, FeedAdapterOptions } from "./types.js";

/**
 * Normalize one GitHub Release into our canonical `Item` shape.
 *
 * Stable id derivation follows ADR-0002 §"Item ID 派生のコントラクト":
 * - `publisherId`: `<tag_name>#<id>` — both fields can change independently
 *   (re-tags rewrite `tag_name` but keep `id`; deleted-and-recreated releases
 *   keep `tag_name` but get a new `id`). Combining them gives the strongest
 *   "same entity" signal available, matching the issue spec
 *   ("stableKey: release tag_name + id").
 * - `url`: the release HTML URL — kept as a secondary fallback even though
 *   GitHub guarantees `id`, so the contract behaves uniformly across adapters.
 * - Title slug: prefer the release `name`; fall back to `tag_name` when the
 *   maintainer left `name` blank (common on auto-cut releases).
 */
function releaseToItem(release: GitHubRelease, source: Source, fetchedAt: string): Item | null {
  const title = release.name?.trim() || release.tag_name;
  const url = release.html_url;
  const publishedAt = toIsoDate(release.published_at ?? release.created_at);
  const summary = release.body?.trim() || undefined;

  const stableKey = deriveStableKey({
    publisherId: `${release.tag_name}#${release.id}`,
    url,
    fallbackHashInputs: [title, publishedAt],
  });
  const id = deriveItemId(title, stableKey);

  const candidate = {
    id,
    sourceId: source.id,
    title,
    url,
    summary,
    publishedAt,
    fetchedAt,
    raw: release,
  };
  const result = ItemSchema.safeParse(candidate);
  // Drop malformed entries silently — one broken release should not poison the
  // whole feed (mirrors the RSS adapter's policy).
  return result.success ? result.data : null;
}

/** Convert a GitHub timestamp to ISO 8601, returning `undefined` for invalid input. */
function toIsoDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export const githubReleasesAdapter: FeedAdapter = {
  kind: "github-releases",
  fetch: async (source: Source, options: FeedAdapterOptions = {}) => {
    const { owner, repo } = parseOwnerRepo(source.url);
    const previous = options.state;
    const fetchedAt = new Date().toISOString();

    const response = await fetchReleases(owner, repo, {
      fetch: options.fetch,
      etag: previous?.lastEtag,
    });

    if (response.notModified) {
      return {
        items: [],
        notModified: true,
        state: {
          lastFetchedAt: fetchedAt,
          lastEtag: response.etag ?? previous?.lastEtag,
        },
      };
    }

    const items = response.releases
      .map((release) => releaseToItem(release, source, fetchedAt))
      .filter((i): i is Item => i !== null);

    return {
      items,
      state: {
        lastFetchedAt: fetchedAt,
        lastEtag: response.etag ?? previous?.lastEtag,
      },
    };
  },
};
