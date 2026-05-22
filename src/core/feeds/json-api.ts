import { createHash } from "node:crypto";
import type {
  Item,
  Source,
  SourceJsonApiSelectors,
  SourcePagination,
} from "../../schemas/index.js";
import { ItemSchema } from "../../schemas/index.js";
import { fetchWithRetry } from "./_fetch.js";
import { selectAll, selectOne } from "./_jsonpath.js";
import { deriveItemId, deriveStableKey } from "./derive-id.js";
import type { FeedAdapter, FeedAdapterOptions, FetchLike } from "./types.js";

const USER_AGENT = "feedradar/0.0.0 (+https://github.com/ozzy-labs/feedradar)";

/**
 * Prefix marking a content-hash entry (vs a real ETag) inside `state.lastEtag`.
 * Mirrors `_html-common.ts` so re-fetches without a server ETag still dedup.
 */
const CONTENT_HASH_PREFIX = "sha256:";

/**
 * Default selector chain consulted when `jsonSelectors.items` is omitted
 * (ADR-0012 §D2). Resolved against the page-0 response body.
 */
const DEFAULT_ITEMS_PATHS = [
  "$.items[*]",
  "$.data[*]",
  "$.results[*]",
  "$.posts[*]",
  "$.entries[*]",
  "$[*]",
] as const;

/**
 * Maximum response body size per page. ADR-0012 §D5a hardcodes this so a
 * malformed recipe cannot blow up memory / context window. The cap is
 * intentionally not user-configurable.
 */
const RESPONSE_SIZE_CAP_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * `${VAR}` env interpolation (ADR-0012 §D5c).
 *
 * - Unresolved variables cause the header to be omitted entirely (degraded
 *   fetch), so public APIs work without env wiring while authenticated APIs
 *   fail-fast with a 401/403 at runtime.
 * - The returned value MUST NEVER be logged. Callers route it directly into
 *   the `headers` map passed to fetch.
 */
function interpolateHeaderValue(
  raw: string,
  env: Record<string, string | undefined>,
): string | undefined {
  // Optimization: most headers contain no `${...}` and pass straight through.
  if (!raw.includes("${")) return raw;
  let resolved = "";
  let i = 0;
  while (i < raw.length) {
    const dollar = raw.indexOf("${", i);
    if (dollar === -1) {
      resolved += raw.slice(i);
      break;
    }
    resolved += raw.slice(i, dollar);
    const close = raw.indexOf("}", dollar + 2);
    if (close === -1) {
      // Malformed: treat as literal so we don't accidentally leak `${` markers
      // into outbound requests. Equivalent to "no interpolation needed".
      resolved += raw.slice(dollar);
      break;
    }
    const name = raw.slice(dollar + 2, close);
    const value = env[name];
    if (value === undefined || value.length === 0) {
      // ADR-0012 §D5c: unresolved → drop the entire header.
      return undefined;
    }
    resolved += value;
    i = close + 1;
  }
  return resolved;
}

/**
 * Build the outgoing `headers` map from the source recipe.
 *
 * Always includes a `user-agent` and `accept: application/json` so most APIs
 * serve JSON without further config. Recipe-supplied headers take precedence
 * over defaults (callers can override `accept` if a site insists on
 * `application/vnd.api+json` etc.).
 */
function buildHeaders(
  source: Source,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, */*;q=0.5",
    "user-agent": USER_AGENT,
  };
  const recipeHeaders = source.http?.headers ?? {};
  for (const [key, raw] of Object.entries(recipeHeaders)) {
    const resolved = interpolateHeaderValue(raw, env);
    if (resolved !== undefined) {
      headers[key.toLowerCase()] = resolved;
    }
    // else: drop unresolved-env header, per ADR-0012 §D5c degraded-fetch policy.
  }
  return headers;
}

/**
 * Compute the next URL for `type: link-header` pagination by parsing
 * `Link: <url>; rel="next", <...>; rel="prev"`. Returns `null` when no
 * `rel="next"` is present (= end of pagination).
 *
 * NOTE on SSRF: a malicious or compromised upstream could emit a `Link`
 * header pointing at `http://127.0.0.1:…` / cloud-metadata endpoints. The
 * host-allowlist defense specified in ADR-0012 §D5b lives in the shared
 * fetch wrapper (`src/core/feeds/_fetch.ts`), which sees every request URL
 * regardless of the adapter that produced it; layering the check here would
 * leave the same gap for `cursor` / `token` pagination and direct
 * `source.url`. Tracking that wrapper-level enforcement as cross-cutting
 * work outside this PR's scope.
 */
function parseLinkHeader(value: string | null): string | null {
  if (!value) return null;
  // RFC 5988: each link is `<url>; param1=val1; param2=val2`, comma-separated.
  // We do not need a full parser — just the first segment whose rel includes
  // "next". Whitespace in URLs is invalid so we can safely match `<...>`.
  const segments = value.split(",");
  for (const segment of segments) {
    const match = segment.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/i);
    if (!match) continue;
    const [, url, rel] = match;
    if (!url || !rel) continue;
    // Some servers emit `rel="next first"` — split on whitespace.
    const rels = rel
      .toLowerCase()
      .split(/\s+/)
      .map((s) => s.trim());
    if (rels.includes("next")) return url;
  }
  return null;
}

/**
 * Apply a query parameter to `url`, replacing any existing one with the same
 * name. Used to thread page / offset / token / pageSize into pagination URLs
 * without re-parsing the recipe URL string each iteration.
 */
function setQueryParam(url: string, name: string, value: string | number): string {
  const u = new URL(url);
  u.searchParams.set(name, String(value));
  return u.toString();
}

/**
 * Resolve `selectors.items` against a page body, falling back to the default
 * selector chain when the recipe omitted the field (ADR-0012 §D2 default
 * chain). Returns the matched item list and the path that produced it (for
 * debug surfaces like `source test`).
 */
function resolveItemsList(
  selectors: SourceJsonApiSelectors,
  body: unknown,
): { matches: unknown[]; path: string } {
  if (selectors.items) {
    return { matches: selectAll(selectors.items, body), path: selectors.items };
  }
  for (const candidate of DEFAULT_ITEMS_PATHS) {
    const matches = selectAll(candidate, body);
    if (matches.length > 0) return { matches, path: candidate };
  }
  return { matches: [], path: DEFAULT_ITEMS_PATHS[0] };
}

/** Coerce a JSON value to a trimmed non-empty string, or `undefined`. */
function coerceString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Coerce a JSON value to ISO 8601, returning `undefined` for invalid input. */
function coerceIsoDate(value: unknown): string | undefined {
  const raw = coerceString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * Normalize one element matched by `selectors.items` into our canonical
 * `Item` shape. Returns `null` when the candidate fails schema validation
 * (e.g. missing url) so one broken record does not abort the whole page.
 *
 * `Item.id` derivation follows ADR-0002:
 *
 * 1. `selectors.publisherId` (explicit, most stable)
 * 2. `selectors.link` URL (canonical identifier)
 * 3. `sha1:` hash of title + publishedAt (fallback)
 */
function elementToItem(
  element: unknown,
  source: Source,
  selectors: SourceJsonApiSelectors,
  fetchedAt: string,
): Item | null {
  const title = coerceString(selectOne(selectors.title, element)) ?? "";
  const url = coerceString(selectOne(selectors.link, element));
  if (!url) return null;
  const publisherId = selectors.publisherId
    ? coerceString(selectOne(selectors.publisherId, element))
    : undefined;
  const publishedAt = selectors.publishedAt
    ? coerceIsoDate(selectOne(selectors.publishedAt, element))
    : undefined;
  const summary = selectors.summary
    ? coerceString(selectOne(selectors.summary, element))
    : undefined;
  const body = selectors.body ? coerceString(selectOne(selectors.body, element)) : undefined;
  // `selectors.tags` is recognized by the schema but currently silently passed
  // through into `raw` only. The filter pipeline (`buildHaystack`) does not
  // structurally read `Item.tags` for any adapter, so surfacing tags
  // structurally here would not improve filtering. Keep them inside `raw`
  // (already attached below) until a future filter extension consumes them.

  const stableKey = deriveStableKey({
    publisherId,
    url,
    fallbackHashInputs: [title, publishedAt],
  });
  const id = deriveItemId(title, stableKey);

  const candidate: Record<string, unknown> = {
    id,
    sourceId: source.id,
    title,
    url,
    fetchedAt,
    raw: element,
  };
  if (publishedAt) candidate.publishedAt = publishedAt;
  if (summary) candidate.summary = summary;
  // Body is preserved inside `raw`; we surface it through summary when the
  // recipe explicitly mapped a body selector and no summary selector. This
  // keeps the Item schema lean while still letting recipes pull in a long
  // description.
  if (!summary && body) candidate.summary = body;

  const result = ItemSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * One iteration of pagination: issue a GET, decode the JSON, return the body
 * + the URL of the next page (or `null` when traversal is done).
 *
 * Errors are thrown to the caller; the adapter wraps them with source-id
 * context before propagating to the watcher.
 */
async function fetchPage(
  url: string,
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  pagination: SourcePagination,
  pageIndex: number,
  state: { etag?: string; sendConditional?: boolean },
): Promise<{
  body: unknown;
  bodyText: string;
  status: number;
  etag: string | null;
  linkNext: string | null;
}> {
  // Forward conditional-GET headers only on page 0 — pagination URLs are
  // ephemeral and most servers will not 304 them. ETag-aware short-circuit
  // is mainly useful for the "no items have changed since last run" case.
  // We also skip conditional GET in backfill mode (caller sets
  // `sendConditional: false`) so a stale ETag from a previous normal-mode
  // run does not 304-out the requested full-history traversal.
  const requestHeaders: Record<string, string> = { ...headers };
  if (
    pageIndex === 0 &&
    state.sendConditional !== false &&
    state.etag &&
    !state.etag.startsWith(CONTENT_HASH_PREFIX) &&
    !("if-none-match" in requestHeaders)
  ) {
    requestHeaders["if-none-match"] = state.etag;
  }

  const response = await fetchWithRetry(fetchImpl, url, { headers: requestHeaders });
  const etag = response.headers.get("etag");
  const linkNext =
    pagination.type === "link-header" ? parseLinkHeader(response.headers.get("link")) : null;

  if (response.status === 304) {
    return { body: null, bodyText: "", status: 304, etag, linkNext };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`json-api adapter: HTTP ${response.status} from ${url}`);
  }

  const bodyText = await response.text();
  if (bodyText.length > RESPONSE_SIZE_CAP_BYTES) {
    throw new Error(
      `json-api adapter: response too large (${bodyText.length} bytes > ${RESPONSE_SIZE_CAP_BYTES} cap) from ${url}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (e) {
    throw new Error(
      `json-api adapter: failed to parse JSON from ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { body: parsed, bodyText, status: response.status, etag, linkNext };
}

/**
 * Compute the next page URL based on the pagination strategy + the current
 * page's body. Returns `null` when traversal should stop (no more pages).
 *
 * `link-header` is handled by the caller (it depends on the response headers,
 * which `fetchPage` reads); we return `null` here so the loop terminates if
 * the recipe says `link-header` but no `Link` header was returned.
 */
function computeNextUrl(
  source: Source,
  pagination: SourcePagination,
  currentUrl: string,
  currentBody: unknown,
  currentItemsLength: number,
  pageCountSoFar: number,
): string | null {
  switch (pagination.type) {
    case "none":
      return null;
    case "link-header":
      // The Link header is read in fetchPage; this branch should never be
      // consulted to compute the next URL directly. Returning null is a safe
      // fallback for buggy recipes that mix `link-header` with explicit
      // `param`.
      return null;
    case "page": {
      if (currentItemsLength === 0) return null;
      const param = pagination.param ?? "page";
      const start = pagination.start ?? 0;
      const nextPage = start + pageCountSoFar;
      let url = setQueryParam(currentUrl, param, nextPage);
      if (pagination.pageSize !== undefined) {
        const sizeParam = pagination.pageSizeParam ?? "pageSize";
        url = setQueryParam(url, sizeParam, pagination.pageSize);
      }
      return url;
    }
    case "offset": {
      if (currentItemsLength === 0) return null;
      const param = pagination.param ?? "offset";
      const start = pagination.start ?? 0;
      const limit = pagination.pageSize ?? currentItemsLength;
      const nextOffset = start + pageCountSoFar * limit;
      let url = setQueryParam(currentUrl, param, nextOffset);
      if (pagination.pageSize !== undefined) {
        const sizeParam = pagination.pageSizeParam ?? "limit";
        url = setQueryParam(url, sizeParam, limit);
      }
      return url;
    }
    case "cursor":
    case "token": {
      if (!pagination.nextCursorPath) return null;
      const cursor = coerceString(selectOne(pagination.nextCursorPath, currentBody));
      if (!cursor) return null;
      const param = pagination.param ?? (pagination.type === "cursor" ? "after" : "pageToken");
      return setQueryParam(source.url, param, cursor);
    }
  }
}

/**
 * Build the initial (page 0) URL by stamping in `start` / `pageSize` from the
 * recipe. For `cursor` / `token` paginations the start cursor is implicit —
 * the recipe URL should already contain whatever initial cursor / token the
 * site expects (typically none).
 */
function initialUrl(source: Source, pagination: SourcePagination): string {
  switch (pagination.type) {
    case "none":
    case "link-header":
    case "cursor":
    case "token":
      // For these types page 0 is just the recipe URL as written.
      return source.url;
    case "page": {
      const param = pagination.param ?? "page";
      const start = pagination.start ?? 0;
      let url = setQueryParam(source.url, param, start);
      if (pagination.pageSize !== undefined) {
        const sizeParam = pagination.pageSizeParam ?? "pageSize";
        url = setQueryParam(url, sizeParam, pagination.pageSize);
      }
      return url;
    }
    case "offset": {
      const param = pagination.param ?? "offset";
      const start = pagination.start ?? 0;
      let url = setQueryParam(source.url, param, start);
      if (pagination.pageSize !== undefined) {
        const sizeParam = pagination.pageSizeParam ?? "limit";
        url = setQueryParam(url, sizeParam, pagination.pageSize);
      }
      return url;
    }
  }
}

/**
 * Effective page cap. Normal mode honors the recipe (`pagination.maxPages`).
 * The natural stop conditions inside the loop (lastSeenIds hit, items.length
 * less than pageSize, empty page) terminate normal-mode traversal earlier
 * than the cap for periodic ingest. Backfill mode honors the recipe cap up
 * to the `--max-pages` override.
 */
function effectiveMaxPages(
  pagination: SourcePagination,
  backfill: boolean,
  override: number | undefined,
): number {
  const recipeCap = pagination.maxPages;
  if (!backfill) {
    return recipeCap;
  }
  if (override !== undefined) return Math.min(recipeCap, override);
  return recipeCap;
}

export const jsonApiAdapter: FeedAdapter = {
  kind: "json-api",
  fetch: async (source: Source, options: FeedAdapterOptions = {}) => {
    if (!source.pagination) {
      throw new Error(`json-api adapter: source '${source.id}' has no pagination config`);
    }
    if (!source.jsonSelectors) {
      throw new Error(`json-api adapter: source '${source.id}' has no jsonSelectors config`);
    }
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof fetchImpl !== "function") {
      throw new Error("json-api adapter: no fetch implementation available (Node 22+ required)");
    }

    const pagination = source.pagination;
    const selectors = source.jsonSelectors;
    const env = options.env ?? (process.env as Record<string, string | undefined>);
    const headers = buildHeaders(source, env);
    const previous = options.state;
    const previousSeen = new Set(previous?.lastSeenIds ?? []);
    const fetchedAt = new Date().toISOString();
    const backfill = options.backfill === true;
    const maxPages = effectiveMaxPages(pagination, backfill, options.maxPagesOverride);

    let currentUrl = initialUrl(source, pagination);
    let pageIndex = 0;
    const items: Item[] = [];
    let lastEtag: string | null = null;
    let firstBodyText: string | null = null;
    let firstBody: unknown = null;
    let notModified = false;
    // Effective cap may tighten mid-traversal when `totalPath` resolves to a
    // value smaller than the recipe's `maxPages` (backfill early stop).
    let effectiveCap = maxPages;

    while (pageIndex < effectiveCap) {
      const response = await fetchPage(currentUrl, fetchImpl, headers, pagination, pageIndex, {
        etag: previous?.lastEtag,
        // Skip conditional GET in backfill mode so a stale ETag from a
        // previous normal-mode run does not 304-out a requested full-history
        // traversal.
        sendConditional: !backfill,
      });
      if (pageIndex === 0) {
        firstBody = response.body;
        firstBodyText = response.bodyText;
        lastEtag = response.etag;
        if (response.status === 304) {
          notModified = true;
          break;
        }
      }
      if (response.status === 304) {
        // 304 on a later page is unusual but treat as end-of-pagination.
        break;
      }

      const { matches } = resolveItemsList(selectors, response.body);
      const pageItems = matches
        .map((m) => elementToItem(m, source, selectors, fetchedAt))
        .filter((i): i is Item => i !== null);

      // Normal-mode early stop: if this page contains an id we have already
      // seen, the older pages will all be older still — stop paginating.
      let hitSeen = false;
      if (!backfill && previousSeen.size > 0) {
        for (const item of pageItems) {
          if (previousSeen.has(item.id)) {
            hitSeen = true;
            break;
          }
        }
      }

      items.push(...pageItems);

      // Stop when the page yielded zero items — protects against runaway
      // pagination on broken recipes / empty trailing pages.
      if (matches.length === 0) break;

      if (hitSeen) break;

      // End-of-pagination heuristic: when the recipe declared a `pageSize`
      // and this page returned fewer matches than that, treat it as the last
      // page. Saves one extra round-trip per source on the common "trailing
      // partial page" case (page 0 of size N, …, page K returns K' < N).
      // Skipped for `cursor` / `token` pagination where `nextCursor` is the
      // authoritative signal — those types may legitimately return fewer
      // items per page than the requested size.
      if (
        pagination.pageSize !== undefined &&
        (pagination.type === "page" || pagination.type === "offset") &&
        matches.length < pagination.pageSize
      ) {
        break;
      }

      // Backfill-mode early stop via `totalPath`: if the recipe declared a
      // total-count selector, narrow the page budget so we exit after the
      // implied last page rather than walking the full `maxPages` cap. We
      // only consult `totalPath` on page 0 because the value is unlikely to
      // change mid-traversal and re-evaluating per page would cost an extra
      // JSONPath walk for negligible benefit.
      if (backfill && pagination.totalPath && pageIndex === 0) {
        const totalRaw = selectOne(pagination.totalPath, response.body);
        const total = typeof totalRaw === "number" ? totalRaw : Number(coerceString(totalRaw));
        if (Number.isFinite(total) && total > 0 && pagination.pageSize) {
          const computedMax = Math.max(1, Math.ceil(total / pagination.pageSize));
          if (computedMax < effectiveCap) {
            effectiveCap = computedMax;
          }
        }
      }

      // Compute next URL.
      let nextUrl: string | null;
      if (pagination.type === "link-header") {
        nextUrl = response.linkNext;
      } else {
        nextUrl = computeNextUrl(
          source,
          pagination,
          currentUrl,
          response.body,
          pageItems.length,
          pageIndex + 1,
        );
      }
      if (!nextUrl) break;

      currentUrl = nextUrl;
      pageIndex++;
    }

    // Build state. Prefer the server-supplied ETag; otherwise hash the page-0
    // body so re-runs without a server ETag still dedup correctly (mirrors the
    // html adapter's content-hash fallback).
    let nextEtag: string | undefined = previous?.lastEtag;
    if (lastEtag) {
      nextEtag = lastEtag;
    } else if (firstBodyText && firstBodyText.length > 0) {
      nextEtag = `${CONTENT_HASH_PREFIX}${createHash("sha256")
        .update(firstBodyText)
        .digest("hex")}`;
    }

    // Avoid unused-variable warnings while keeping `firstBody` available for
    // future debug surfaces (`source test` may want to print the first page
    // body when no items matched).
    void firstBody;

    if (notModified) {
      return {
        items: [],
        notModified: true,
        state: {
          lastFetchedAt: fetchedAt,
          lastEtag: nextEtag,
        },
      };
    }

    return {
      items,
      state: {
        lastFetchedAt: fetchedAt,
        lastEtag: nextEtag,
      },
    };
  },
};
