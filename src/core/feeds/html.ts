import type { Source } from "../../schemas/index.js";
import { CONTENT_HASH_PREFIX, contentHash, parseHtmlDocument } from "./_html-common.js";
import type { FeedAdapter, FeedAdapterOptions, FetchLike } from "./types.js";

// Re-export shared primitives so existing imports (and tests) that pulled
// `parseHtmlDocument` from this module keep working after the
// `_html-common.ts` split (ADR-0010 §D1, no behavior change).
export { parseHtmlDocument } from "./_html-common.js";

const USER_AGENT = "feedradar/0.0.0 (+https://github.com/ozzy-labs/feedradar)";

/**
 * Issue an HTTP GET with conditional headers. The previous `lastEtag` slot
 * may contain either an actual ETag (mirror RSS behavior) or a `sha256:`
 * content hash; we only forward real ETags as `If-None-Match`.
 */
async function fetchHtml(
  url: string,
  fetchImpl: FetchLike,
  options: { etag?: string; signal?: AbortSignal } = {},
): Promise<{
  status: number;
  body: string;
  etag: string | null;
}> {
  const headers: Record<string, string> = {
    accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.5",
    "user-agent": USER_AGENT,
  };
  // Only forward the previous value to the server when it looks like a real
  // ETag; a `sha256:` slot is our own dedup marker, not something the server
  // sent us.
  if (options.etag && !options.etag.startsWith(CONTENT_HASH_PREFIX)) {
    headers["if-none-match"] = options.etag;
  }

  const response = await fetchImpl(url, { headers, signal: options.signal });
  const etag = response.headers.get("etag");
  if (response.status === 304) {
    return { status: 304, body: "", etag };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`html adapter: HTTP ${response.status} from ${url}`);
  }
  const body = await response.text();
  return { status: response.status, body, etag };
}

export const htmlAdapter: FeedAdapter = {
  kind: "html",
  fetch: async (source: Source, options: FeedAdapterOptions = {}) => {
    if (!source.selectors) {
      throw new Error(`html adapter: source '${source.id}' has no selectors`);
    }
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof fetchImpl !== "function") {
      throw new Error("html adapter: no fetch implementation available (Node 22+ required)");
    }
    const previous = options.state;
    const fetchedAt = new Date().toISOString();
    const response = await fetchHtml(source.url, fetchImpl, {
      etag: previous?.lastEtag,
    });
    if (response.status === 304) {
      return {
        items: [],
        notModified: true,
        state: {
          lastFetchedAt: fetchedAt,
          // Preserve whatever marker we had — server may not echo the ETag
          // back on 304, in which case we keep the previous content hash too.
          lastEtag: response.etag ?? previous?.lastEtag,
        },
      };
    }

    // Content-hash fallback: when the server does not return an ETag at all,
    // compare a sha256 of the body against the previous one we recorded so
    // re-fetches without a real ETag still dedup correctly.
    const bodyHash = contentHash(response.body);
    const previousMarker = previous?.lastEtag;
    if (!response.etag && previousMarker === bodyHash) {
      return {
        items: [],
        notModified: true,
        state: {
          lastFetchedAt: fetchedAt,
          lastEtag: bodyHash,
        },
      };
    }

    const items = parseHtmlDocument(response.body, source, fetchedAt);
    return {
      items,
      state: {
        lastFetchedAt: fetchedAt,
        // Prefer the real ETag when the server provides one; otherwise stash
        // the content hash in the same slot for next-run dedup.
        lastEtag: response.etag ?? bodyHash,
      },
    };
  },
};
