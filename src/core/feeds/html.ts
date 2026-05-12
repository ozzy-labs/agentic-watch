import { createHash } from "node:crypto";
import { type HTMLElement, parse as parseHtml } from "node-html-parser";
import type { Item, Source, SourceSelectors } from "../../schemas/index.js";
import { ItemSchema } from "../../schemas/index.js";
import { deriveItemId, deriveStableKey } from "./derive-id.js";
import type { FeedAdapter, FeedAdapterOptions, FetchLike } from "./types.js";

const USER_AGENT = "agentic-watch/0.0.0 (+https://github.com/ozzy-labs/agentic-watch)";

/**
 * Prefix that flags an `lastEtag` slot as carrying a content hash rather than
 * an actual HTTP ETag. We reuse the `lastEtag` field so this Phase does not
 * have to migrate `SourceState` (see `docs/design/source-html.md`).
 */
const CONTENT_HASH_PREFIX = "sha256:";

/** Attributes the adapter checks before falling back to text content. */
const DATETIME_ATTRS = ["datetime", "content", "value"] as const;

/**
 * Convert an `HTMLElement | null` to its trimmed text, or `undefined` when
 * the selector did not match. We always trim because raw scrapes routinely
 * carry surrounding whitespace from formatted markup.
 */
function textOf(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  const text = el.text?.trim();
  return text ? text : undefined;
}

/**
 * Apply a CSS selector relative to `root` and return the first match.
 * `node-html-parser` returns `null` instead of throwing for invalid input,
 * which matches what callers want here (a missing field, not a hard error).
 */
function queryFirst(root: HTMLElement, selector: string): HTMLElement | null {
  return root.querySelector(selector);
}

/**
 * Resolve the `link` selector to an `href` (or text fallback).
 *
 * Anchor tags expose the URL via `href` so we prefer the attribute. When the
 * selector points at a non-anchor (e.g. a `<div data-link>` wrapper used by
 * some changelog layouts), we fall back to text content so the adapter can
 * still operate, deferring URL validation to `ItemSchema`.
 */
function pickLink(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  const href = el.getAttribute("href");
  if (href && href.trim()) return href.trim();
  return textOf(el);
}

/**
 * Resolve `publishedAt` to a candidate string for `new Date()`.
 *
 * `<time datetime="2026-05-12">` and `<meta content="..."/>` markup hide the
 * canonical timestamp in attributes; the visible text is often a
 * localized "May 12, 2026" that is harder to parse reliably. We probe the
 * known attributes first, then fall back to element text.
 */
function pickDatetime(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  for (const attr of DATETIME_ATTRS) {
    const value = el.getAttribute(attr);
    if (value && value.trim()) return value.trim();
  }
  return textOf(el);
}

/**
 * Try to parse a candidate timestamp into ISO 8601. Returns `undefined` for
 * unparseable inputs so the item can still be emitted (RSS adapter parity).
 */
function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/** Collect the trimmed text of every match for `selector`. */
function collectTags(root: HTMLElement, selector: string | undefined): string[] | undefined {
  if (!selector) return undefined;
  const tags = root
    .querySelectorAll(selector)
    .map((el) => el.text?.trim())
    .filter((t): t is string => !!t && t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

/**
 * Resolve a relative `link` against the source URL.
 *
 * Many sites publish `<a href="/changelog/foo">` rather than absolute URLs;
 * without resolution `ItemSchema`'s `z.string().url()` would drop them. We
 * intentionally swallow `URL` constructor errors so a malformed `link`
 * surfaces as a normal validation drop later instead of breaking the whole
 * fetch.
 */
function resolveUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
}

/** Normalize one matched element into an Item, or `null` to drop it. */
function parseItem(
  itemEl: HTMLElement,
  selectors: SourceSelectors,
  source: Source,
  fetchedAt: string,
): Item | null {
  const title = textOf(queryFirst(itemEl, selectors.title));
  const linkRaw = pickLink(queryFirst(itemEl, selectors.link));
  if (!title || !linkRaw) return null;
  const url = resolveUrl(linkRaw, source.url);

  const summary = selectors.summary ? textOf(queryFirst(itemEl, selectors.summary)) : undefined;
  const body = selectors.body ? textOf(queryFirst(itemEl, selectors.body)) : undefined;
  const publishedAt = selectors.publishedAt
    ? toIsoDate(pickDatetime(queryFirst(itemEl, selectors.publishedAt)))
    : undefined;
  const tags = collectTags(itemEl, selectors.tags);

  const stableKey = deriveStableKey({
    url,
    fallbackHashInputs: [title, publishedAt],
  });
  const id = deriveItemId(title, stableKey);

  // Preserve a structured snapshot of the raw scrape rather than the
  // `HTMLElement` instance itself — the watcher serializes `raw` to YAML and
  // we want the on-disk payload to be diff-friendly.
  const raw: Record<string, unknown> = { title, link: linkRaw };
  if (summary !== undefined) raw.summary = summary;
  if (body !== undefined) raw.body = body;
  if (publishedAt !== undefined) raw.publishedAt = publishedAt;
  if (tags !== undefined) raw.tags = tags;

  return validateItem({
    id,
    sourceId: source.id,
    title,
    url,
    summary,
    publishedAt,
    fetchedAt,
    raw,
  });
}

function validateItem(candidate: Record<string, unknown>): Item | null {
  const result = ItemSchema.safeParse(candidate);
  // Items that fail validation (e.g. unresolvable URL) are dropped silently —
  // see rss.ts for the same fail-soft rationale.
  return result.success ? result.data : null;
}

/**
 * Parse an HTML document into validated `Item[]` using the source's
 * `selectors`. Exported so tests can drive the parser directly without
 * needing a fake HTTP layer.
 */
export function parseHtmlDocument(html: string, source: Source, fetchedAt: string): Item[] {
  if (!source.selectors) {
    throw new Error(`html adapter: source '${source.id}' has no selectors`);
  }
  const selectors = source.selectors;
  let root: HTMLElement;
  try {
    root = parseHtml(html);
  } catch (e) {
    throw new Error(
      `html adapter: failed to parse HTML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const itemEls = root.querySelectorAll(selectors.item);
  return itemEls
    .map((el) => parseItem(el, selectors, source, fetchedAt))
    .filter((i): i is Item => i !== null);
}

/**
 * Compute the sha256 of the raw response body, prefixed so callers can tell
 * it apart from a real ETag inside `SourceState.lastEtag`.
 */
function contentHash(body: string): string {
  return `${CONTENT_HASH_PREFIX}${createHash("sha256").update(body).digest("hex")}`;
}

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
