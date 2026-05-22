import type { Item, Source } from "../../schemas/index.js";
import { ItemSchema } from "../../schemas/index.js";
import { fetchWithRetry } from "./_fetch.js";
import { deriveItemId, deriveStableKey } from "./derive-id.js";
import type { FeedAdapter, FeedAdapterOptions, FetchLike } from "./types.js";

/**
 * `kind: json-feed` adapter — JSON Feed 1.0 / 1.1 zero-config parser.
 *
 * JSON Feed (https://jsonfeed.org/version/1.1) is a standardized JSON-based
 * feed format. Because it is a real standard with a fixed schema, a single
 * adapter can handle every conforming site with **URL only** — no recipe,
 * no per-site config (ADR-0012 L0 tier, alongside `kind: rss`).
 *
 * What this adapter handles:
 * - JSON Feed 1.0 (`version: "https://jsonfeed.org/version/1"`) and 1.1
 *   (`"https://jsonfeed.org/version/1.1"`). Both share the same item shape,
 *   so version is only validated up-front for fail-fast safety.
 * - `items[].{id, url, title, content_text, content_html, date_published,
 *   tags}` — the fields downstream filters / research / dedup actually use.
 * - `next_url` pagination: when present, we follow links transitively up to
 *   `MAX_PAGES` to gather full history in a single fetch round.
 *
 * What is intentionally NOT handled:
 * - JSON Feed extensions (`_*` keys, `author`, `attachments`, …). The full
 *   payload is preserved in `Item.raw` so future code can grow into them
 *   without breaking persisted state.
 * - HTTP `next_url` cycles or unbounded chains — both are bounded by
 *   `MAX_PAGES` to keep memory and rate-limit usage predictable.
 */

const USER_AGENT = "feedradar/0.0.0 (+https://github.com/ozzy-labs/feedradar)";

/**
 * Page-traversal cap for `next_url`. Each page is a single JSON parse + items
 * loop, so 50 pages with the default ~100 items/page is well below the OOM
 * threshold while still covering history-heavy personal blogs in one fetch.
 * Higher caps belong behind the `--backfill` flag (#173) when it lands.
 */
const MAX_PAGES = 50;

/**
 * Accepted `version` URIs. JSON Feed has only ever published 1.0 and 1.1;
 * both share the item schema fields this adapter reads, so we accept either.
 * Anything else (typo, `application/json` mistakenly served, future major
 * version) is rejected so we fail fast instead of silently producing junk.
 */
const VERSION_PREFIX = "https://jsonfeed.org/version/";

/** Minimum subset of a JSON Feed item we touch — everything else is preserved in `raw`. */
interface JsonFeedItemLike {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  content_text?: unknown;
  content_html?: unknown;
  summary?: unknown;
  date_published?: unknown;
  tags?: unknown;
}

interface JsonFeedLike {
  version?: unknown;
  items?: unknown;
  next_url?: unknown;
}

/** Treat empty / whitespace-only strings as missing, like other adapters do. */
function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Normalize `tags` to a `string[]`, dropping non-string entries silently. */
function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t.length > 0);
}

/** Parse `date_published` (ISO 8601 per spec) into our canonical ISO string. */
function toIsoDate(value: unknown): string | undefined {
  const s = asString(value);
  if (!s) return undefined;
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * Validate the top-level `version` field. Returns `true` for the two
 * published versions, `false` for anything else (including missing).
 *
 * We do strict equality on the canonical version URIs rather than a prefix
 * match because the spec defines exactly two values; a future 2.0 will need
 * an explicit code change here so we never quietly mis-parse.
 */
function isAcceptedVersion(value: unknown): boolean {
  const s = asString(value);
  if (!s) return false;
  return s === `${VERSION_PREFIX}1` || s === `${VERSION_PREFIX}1.1`;
}

/**
 * Normalize one JSON Feed item into our canonical `Item`.
 *
 * Stable id derivation follows ADR-0002 §"Item ID 派生のコントラクト":
 * - `publisherId`: `item.id` — JSON Feed spec mandates this is unique per
 *   item, so it is the strongest identity signal we have.
 * - `url`: `item.url` — preferred fallback when `id` is missing (some
 *   real-world feeds skip `id` even though spec requires it; we mirror
 *   the lenient parsing of mainstream readers).
 * - Title slug: prefer `item.title`; spec marks it optional so we tolerate
 *   missing titles and fall through to hash-only id via `deriveItemId`.
 */
function itemToItem(raw: JsonFeedItemLike, source: Source, fetchedAt: string): Item | null {
  const id = asString(raw.id);
  const url = asString(raw.url);
  if (!url) return null; // Item.url is required by our schema (z.string().url()).

  const title = asString(raw.title) ?? "";
  // content_html wins over content_text when both are present (per issue
  // #177 spec). When only one exists, use that one. Falling back to
  // `summary` keeps short-form feeds (microblogs) from producing empty items.
  const html = asString(raw.content_html);
  const text = asString(raw.content_text);
  const summary = html ?? text ?? asString(raw.summary);
  const publishedAt = toIsoDate(raw.date_published);
  // Normalize `tags` defensively (drop non-strings, trim, drop empties) so a
  // malformed `tags` array does not poison the downstream `raw` consumers.
  // The Item schema does not yet surface a structured `tags` field, so the
  // normalized value lives inside `raw` for now; ADR-0006 marks tag-filter
  // routing as a future extension. See issue #177.
  const tags = asTags(raw.tags);
  const normalizedRaw = { ...raw, tags };

  const stableKey = deriveStableKey({
    publisherId: id,
    url,
    fallbackHashInputs: [title, publishedAt],
  });
  const itemId = deriveItemId(title, stableKey);

  const candidate = {
    id: itemId,
    sourceId: source.id,
    title,
    url,
    summary,
    publishedAt,
    fetchedAt,
    raw: normalizedRaw,
  };
  // Items that fail validation (malformed URL etc.) are dropped silently — the
  // alternative is failing the whole feed for one bad entry, which surprises
  // users running large feeds where one broken entry is common.
  const result = ItemSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * Parse a single JSON Feed document into `Item[]` (no pagination). Exposed
 * for unit tests so fixtures can exercise the parser without a fetch stub.
 */
export function parseJsonFeed(body: string, source: Source, fetchedAt: string): Item[] {
  let doc: JsonFeedLike;
  try {
    doc = JSON.parse(body) as JsonFeedLike;
  } catch (e) {
    throw new Error(
      `json-feed adapter: failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isAcceptedVersion(doc.version)) {
    throw new Error(
      `json-feed adapter: unsupported or missing 'version' field (expected ${VERSION_PREFIX}1 or ${VERSION_PREFIX}1.1)`,
    );
  }
  const items = Array.isArray(doc.items) ? (doc.items as JsonFeedItemLike[]) : [];
  return items
    .map((entry) => itemToItem(entry, source, fetchedAt))
    .filter((i): i is Item => i !== null);
}

/** Extract `next_url` if it is a non-empty string; ignore non-string / empty. */
export function extractNextUrl(body: string): string | undefined {
  try {
    const doc = JSON.parse(body) as JsonFeedLike;
    return asString(doc.next_url);
  } catch {
    return undefined;
  }
}

/**
 * Issue an HTTP GET with conditional headers, honoring previously stored
 * `ETag` / `Last-Modified` so well-behaved servers can reply 304 and let us
 * skip parsing work. Shared fetch wrapper supplies timeout + retry.
 */
async function fetchJsonFeed(
  url: string,
  fetchImpl: FetchLike,
  options: { etag?: string; lastModified?: string; signal?: AbortSignal } = {},
): Promise<{ status: number; body: string; etag: string | null; lastModified: string | null }> {
  const headers: Record<string, string> = {
    accept: "application/feed+json, application/json;q=0.9, */*;q=0.5",
    "user-agent": USER_AGENT,
  };
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.lastModified) headers["if-modified-since"] = options.lastModified;

  const response = await fetchWithRetry(fetchImpl, url, { headers, signal: options.signal });
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (response.status === 304) {
    return { status: 304, body: "", etag, lastModified };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`json-feed adapter: HTTP ${response.status} from ${url}`);
  }
  const body = await response.text();
  return { status: response.status, body, etag, lastModified };
}

export const jsonFeedAdapter: FeedAdapter = {
  kind: "json-feed",
  fetch: async (source: Source, options: FeedAdapterOptions = {}) => {
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof fetchImpl !== "function") {
      throw new Error("json-feed adapter: no fetch implementation available (Node 22+ required)");
    }
    const previous = options.state;
    const fetchedAt = new Date().toISOString();

    // First page uses conditional headers; subsequent pages do not (the
    // server-side `next_url` chain is page-specific, not feed-wide, so a 304
    // would be meaningless after the first hop).
    const response = await fetchJsonFeed(source.url, fetchImpl, {
      etag: previous?.lastEtag,
      lastModified: previous?.lastModified,
    });
    if (response.status === 304) {
      return {
        items: [],
        notModified: true,
        state: {
          lastFetchedAt: fetchedAt,
          lastEtag: response.etag ?? previous?.lastEtag,
          lastModified: response.lastModified ?? previous?.lastModified,
        },
      };
    }

    const collected: Item[] = parseJsonFeed(response.body, source, fetchedAt);
    let nextUrl = extractNextUrl(response.body);
    const visited = new Set<string>([source.url]);
    let pages = 1;
    while (nextUrl && pages < MAX_PAGES && !visited.has(nextUrl)) {
      visited.add(nextUrl);
      const pageResponse = await fetchJsonFeed(nextUrl, fetchImpl);
      // 304 has no body so we just stop walking the chain.
      if (pageResponse.status === 304) break;
      const pageItems = parseJsonFeed(pageResponse.body, source, fetchedAt);
      collected.push(...pageItems);
      nextUrl = extractNextUrl(pageResponse.body);
      pages += 1;
    }

    return {
      items: collected,
      state: {
        lastFetchedAt: fetchedAt,
        lastEtag: response.etag ?? previous?.lastEtag,
        lastModified: response.lastModified ?? previous?.lastModified,
      },
    };
  },
};
