import { createHash } from "node:crypto";
import { type HTMLElement, parse as parseHtml } from "node-html-parser";
import type { Item, Source, SourceSelectors } from "../../schemas/index.js";
import { ItemSchema } from "../../schemas/index.js";
import { deriveItemId, deriveStableKey } from "./derive-id.js";

/**
 * Shared parsing primitives for the `kind: html` (static) and `kind: html-js`
 * (Playwright-rendered) adapters (ADR-0010 §D1).
 *
 * Both adapters apply the same `SourceSelectors` contract to a serialized HTML
 * string — the only difference is how that string was acquired (raw HTTP body
 * vs `page.content()` after JS execution). Extracting `parseHtmlDocument` and
 * `contentHash` here keeps the selector semantics and dedup marker format in
 * lockstep so a switch from `html` to `html-js` is transparent to downstream
 * consumers (dedup, state file, watcher).
 */

/**
 * Prefix that flags an `lastEtag` slot as carrying a content hash rather than
 * an actual HTTP ETag. Both adapters reuse the `lastEtag` field so neither
 * has to migrate `SourceState` (see `docs/design/source-html.md`).
 */
export const CONTENT_HASH_PREFIX = "sha256:";

/** Attributes the parser checks before falling back to text content. */
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
 * `selectors`. Both `kind: html` and `kind: html-js` go through here so the
 * selector contract stays in one place.
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
export function contentHash(body: string): string {
  return `${CONTENT_HASH_PREFIX}${createHash("sha256").update(body).digest("hex")}`;
}
