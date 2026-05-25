import { createHash } from "node:crypto";
import type {
  FacetRangeEnd,
  Item,
  Source,
  SourceFacet,
  SourceJsonApiSelectors,
  SourcePagination,
} from "../../schemas/index.js";
import { FACET_RANGE_CURRENT_YEAR, ItemSchema } from "../../schemas/index.js";
import { fetchWithRetry } from "./_fetch.js";
import { selectAll, selectOne } from "./_jsonpath.js";
import { deriveItemId, deriveStableKey } from "./derive-id.js";
import type {
  FeedAdapter,
  FeedAdapterOptions,
  FeedFetchDiag,
  FeedFetchResult,
  FetchLike,
} from "./types.js";

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
 * Per-field default selector chain consulted when the corresponding
 * `jsonSelectors.<field>` is omitted (#174). For each item element we walk
 * the chain in order and use the first path that yields a non-nullish value;
 * this lets recipes for "simple" APIs (dev.to, generic JSON Feed clones)
 * skip selectors entirely. Adoption is recorded once per fetch (first item)
 * and surfaced via `FeedFetchDiag.selectorAdoption` so users can audit which
 * candidate was picked.
 */
const DEFAULT_FIELD_PATHS = {
  title: ["$.title", "$.name", "$.headline"],
  link: ["$.url", "$.link", "$.permalink", "$.html_url"],
  publishedAt: ["$.publishedAt", "$.published_at", "$.date", "$.created_at", "$.pubDate"],
  summary: ["$.summary", "$.description", "$.excerpt", "$.body"],
} as const;

type DefaultableField = keyof typeof DEFAULT_FIELD_PATHS;

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

/**
 * Resolve a per-item field with optional default-chain fallback.
 *
 * `explicit` is the recipe-supplied path. When undefined, we walk
 * `DEFAULT_FIELD_PATHS[field]` and return the first candidate that yields
 * a non-nullish value, or `{ value: undefined, path: null }` when every
 * candidate misses.
 *
 * Returning the matched path lets the adapter record adoption once (first
 * item) and surface it via `diag.selectorAdoption` so `source test` can
 * print "title ← $.headline を採用".
 */
function resolveFieldWithFallback(
  field: DefaultableField,
  explicit: string | undefined,
  element: unknown,
): { value: unknown; path: string | null } {
  if (explicit) {
    return { value: selectOne(explicit, element), path: explicit };
  }
  for (const candidate of DEFAULT_FIELD_PATHS[field]) {
    const value = selectOne(candidate, element);
    if (value !== undefined && value !== null) {
      return { value, path: candidate };
    }
  }
  return { value: undefined, path: null };
}

/**
 * Resolve a `link` value against a base URL (#204).
 *
 * Many JSON APIs (notably AWS What's New) return the per-item link as a
 * relative path like `/about-aws/whats-new/.../` rather than a fully
 * qualified URL. Without resolution `ItemSchema`'s `z.string().url()`
 * silently drops every item.
 *
 * The base is `selectors.linkBase` when set, otherwise `source.url` (which
 * mirrors the html adapter's `new URL(href, source.url)` behavior). Absolute
 * URLs pass through unchanged because `new URL("https://x/y", base)` ignores
 * the base.
 *
 * We swallow `URL` constructor errors so a malformed `link` surfaces as a
 * normal `ItemSchema` validation drop later (preserving the existing "one
 * broken record does not abort the whole page" semantics).
 */
function resolveLinkUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
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
 *
 * `adoption` is mutated in place: for each defaultable field, the first call
 * records the JSONPath candidate that produced a usable value (or `null` if
 * every candidate missed). Subsequent calls leave it alone so adoption
 * reflects the very first item — that is what `source test` reports.
 */
function elementToItem(
  element: unknown,
  source: Source,
  selectors: SourceJsonApiSelectors,
  fetchedAt: string,
  adoption: Record<DefaultableField, string | null | undefined>,
): Item | null {
  const titleResolved = resolveFieldWithFallback("title", selectors.title, element);
  if (adoption.title === undefined) {
    adoption.title = titleResolved.path;
  }
  const title = coerceString(titleResolved.value) ?? "";

  const linkResolved = resolveFieldWithFallback("link", selectors.link, element);
  if (adoption.link === undefined) {
    adoption.link = linkResolved.path;
  }
  const rawLink = coerceString(linkResolved.value);
  if (!rawLink) return null;
  // Resolve relative paths against `linkBase` (or `source.url` as fallback)
  // so APIs that return `/about-aws/whats-new/.../` instead of an absolute
  // URL still produce valid `Item.url` values (#204). Absolute URLs pass
  // through `new URL()` unchanged.
  const url = resolveLinkUrl(rawLink, selectors.linkBase ?? source.url);

  const publisherId = selectors.publisherId
    ? coerceString(selectOne(selectors.publisherId, element))
    : undefined;

  const publishedAtResolved = resolveFieldWithFallback(
    "publishedAt",
    selectors.publishedAt,
    element,
  );
  if (adoption.publishedAt === undefined) {
    adoption.publishedAt = publishedAtResolved.path;
  }
  const publishedAt = coerceIsoDate(publishedAtResolved.value);

  const summaryResolved = resolveFieldWithFallback("summary", selectors.summary, element);
  if (adoption.summary === undefined) {
    adoption.summary = summaryResolved.path;
  }
  const summary = coerceString(summaryResolved.value);
  const body = selectors.body ? coerceString(selectOne(selectors.body, element)) : undefined;
  // `selectors.tags` is recognized by the schema but currently silently passed
  // through into `raw` only. The filter pipeline (`evaluateFilter`) does not
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

/**
 * Apply a single facet value to the source URL by injecting the templated
 * query parameter. Replaces any existing value of `facet.param` so a recipe
 * URL with a placeholder/default does not double-up at fetch time.
 */
function applyFacetValue(rawUrl: string, facet: SourceFacet, value: string | number): string {
  const u = new URL(rawUrl);
  const substituted = facet.template.replace("{}", String(value));
  u.searchParams.set(facet.param, substituted);
  return u.toString();
}

/**
 * Resolve a range upper bound to a concrete number.
 *
 * The `"current-year"` sentinel (#257) expands to the current calendar year
 * at fetch time so year-axis recipes auto-extend across year boundaries
 * instead of silently capping at a hardcoded upper bound. `now` is injected
 * for deterministic testing; it defaults to the wall clock.
 */
function resolveRangeEnd(end: FacetRangeEnd, now: Date = new Date()): number {
  return end === FACET_RANGE_CURRENT_YEAR ? now.getFullYear() : end;
}

/**
 * Enumerate the facet values for a single facet spec.
 *
 * - `range`: `[start, end]` inclusive, walked with `step` (default 1).
 *   Schema guarantees `step > 0`. The upper bound may be the literal
 *   `"current-year"` sentinel, resolved here to the current calendar year
 *   (#257); when start > the resolved end the loop yields nothing (a future-
 *   dated start is a degenerate 0-item config, not an error).
 * - `enum`: returns the explicit list verbatim (string or number).
 */
function* generateFacetValues(facet: SourceFacet): Generator<string | number> {
  if (facet.type === "range") {
    const [start, rawEnd] = facet.range;
    const end = resolveRangeEnd(rawEnd);
    const step = facet.step;
    for (let v = start; v <= end; v += step) yield v;
    return;
  }
  for (const v of facet.values) yield v;
}

/**
 * Count the facet values a real (non-dry-run) sweep would walk.
 *
 * Used purely for the `source test` warning denominator ("testing 1 of N
 * facet values") — the real sweep still iterates {@link generateFacetValues}.
 */
function countFacetValues(facet: SourceFacet): number {
  if (facet.type === "range") {
    const [start, rawEnd] = facet.range;
    const end = resolveRangeEnd(rawEnd);
    if (start > end) return 0;
    return Math.floor((end - start) / facet.step) + 1;
  }
  return facet.values.length;
}

/**
 * Pick the single facet value to probe in dry-run mode (`source test`).
 *
 * - `range`: the resolved UPPER bound (latest year via {@link resolveRangeEnd},
 *   honouring the `"current-year"` sentinel from #257). This fixes #256 —
 *   recency-style recipes (e.g. AWS What's New swept by year) were previously
 *   tested against the range START (oldest year, e.g. 2004), where current
 *   keywords can never match. Testing the latest year makes keyword tuning
 *   meaningful. Returns `null` for a degenerate `start > end` range (no value
 *   to probe).
 * - `enum`: the first listed value. Enum facets have no "latest" ordering, so
 *   we keep the historical first-value behaviour.
 */
function pickDryRunFacetValue(facet: SourceFacet): string | number | null {
  if (facet.type === "range") {
    const [start, rawEnd] = facet.range;
    const end = resolveRangeEnd(rawEnd);
    if (start > end) return null;
    // Walk down from `end` by `step` to land on a value the real sweep would
    // actually visit (the inclusive range may not include `end` itself when
    // step > 1 and (end - start) is not a multiple of step).
    const offset = (end - start) % facet.step;
    return end - offset;
  }
  return facet.values[0] ?? null;
}

/**
 * Inner fetch — the original single-axis (pagination-only) traversal. The
 * public adapter delegates here either directly (no facets) or once per
 * facet value (facet sweep mode).
 *
 * `dryRun` is preserved (single-page fetch behaviour) but the public
 * adapter narrows it further in facet sweep mode to a single facet value
 * (the range upper bound / latest year, or the first enum value — see
 * {@link pickDryRunFacetValue}) so `source test` does not walk every year.
 */
async function fetchSingle(source: Source, options: FeedAdapterOptions): Promise<FeedFetchResult> {
  if (!source.pagination) {
    throw new Error(`json-api adapter: source '${source.id}' has no pagination config`);
  }
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== "function") {
    throw new Error("json-api adapter: no fetch implementation available (Node 22+ required)");
  }

  const pagination = source.pagination;
  // `jsonSelectors` is optional in the schema (#174). When omitted, every
  // field falls back to its default chain so trivial APIs (dev.to,
  // generic JSON Feed clones) work without a selector block at all.
  const selectors = source.jsonSelectors ?? {};
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const headers = buildHeaders(source, env);
  const previous = options.state;
  const previousSeen = new Set(previous?.lastSeenIds ?? []);
  const fetchedAt = new Date().toISOString();
  const backfill = options.backfill === true;
  const dryRun = options.dryRun === true;
  const warn = options.warn ?? (() => {});
  const onPage = options.onPage;
  const maxPages = effectiveMaxPages(pagination, backfill, options.maxPagesOverride);

  let currentUrl = initialUrl(source, pagination);
  let pageIndex = 0;
  const items: Item[] = [];
  let lastEtag: string | null = null;
  let firstBodyText: string | null = null;
  let firstBody: unknown = null;
  let notModified = false;
  // `undefined` means "not seen yet"; once we normalize the first item we
  // overwrite each entry with either the matched path (string) or `null`
  // (no candidate yielded a value). The diag payload reports the final
  // state at end-of-fetch.
  const adoption: Record<DefaultableField, string | null | undefined> = {
    title: undefined,
    link: undefined,
    publishedAt: undefined,
    summary: undefined,
  };
  let itemsPath: string | null = null;
  let paginationPreview: FeedFetchDiag["paginationPreview"] | undefined;
  // Effective cap may tighten mid-traversal when `totalPath` resolves to a
  // value smaller than the recipe's `maxPages` (backfill early stop).
  let effectiveCap = maxPages;
  // Dry-run mode short-circuits after page 0: we record the diag preview
  // (next URL / Link header / nextCursor) but never fetch page 1.
  if (dryRun) effectiveCap = Math.min(effectiveCap, 1);

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

    const itemsResult = resolveItemsList(selectors, response.body);
    if (pageIndex === 0) itemsPath = itemsResult.path;
    const matches = itemsResult.matches;
    const pageItems = matches
      .map((m) => elementToItem(m, source, selectors, fetchedAt, adoption))
      .filter((i): i is Item => i !== null);

    // Surface a pagination preview for `source test` on page 0 only. We
    // compute the *would-be* next URL / cursor / Link header but never
    // actually fetch it in dry-run mode (#174 state-clean invariant).
    if (pageIndex === 0) {
      const linkHeaderNext = pagination.type === "link-header" ? response.linkNext : undefined;
      let nextCursor: string | null | undefined;
      if (
        (pagination.type === "cursor" || pagination.type === "token") &&
        pagination.nextCursorPath
      ) {
        nextCursor = coerceString(selectOne(pagination.nextCursorPath, response.body)) ?? null;
      }
      let previewNextUrl: string | null;
      if (pagination.type === "link-header") {
        previewNextUrl = response.linkNext;
      } else {
        previewNextUrl = computeNextUrl(
          source,
          pagination,
          currentUrl,
          response.body,
          pageItems.length,
          1,
        );
      }
      paginationPreview = {
        strategy: pagination.type,
        nextUrl: previewNextUrl,
        ...(linkHeaderNext !== undefined ? { linkHeaderNext } : {}),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    }

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

    // Backfill-mode early stop via `totalPath`: if the recipe declared a
    // total-count selector, narrow the page budget so we exit after the
    // implied last page rather than walking the full `maxPages` cap. We
    // only consult `totalPath` on page 0 because the value is unlikely to
    // change mid-traversal and re-evaluating per page would cost an extra
    // JSONPath walk for negligible benefit.
    //
    // Applied BEFORE the `onPage` callback below so the user-visible
    // `Page N/M` denominator already reflects the narrowed cap on the
    // very first page event (otherwise the spinner ratio would jump
    // from `1/20` to `1/2` between page 0 and page 1, which reads as a
    // bug).
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

    // Surface per-page progress to the CLI spinner / non-TTY log (#198).
    // The callback is invoked before any early-exit checks below so the
    // user always sees a final `Page N/N` event for the page that decided
    // termination. `effectiveCap` is the denominator the loop will respect
    // (recipe `maxPages`, narrowed by `totalPath` on page 0 in backfill
    // mode above), so the user-visible ratio shrinks as the budget tightens.
    if (onPage) {
      onPage({
        pageIndex,
        pageTotal: effectiveCap,
        items: pageItems.length,
      });
    }

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

  // Warn for default-chain fields where every candidate returned null —
  // recipe authors typically want to know the API has a non-standard
  // shape (e.g. `additionalFields.headline` instead of `$.title`). We
  // skip the warning when the recipe explicitly declared the selector
  // (the absence is then on the user, not the default chain).
  for (const field of Object.keys(adoption) as DefaultableField[]) {
    const explicit = selectors[field];
    if (!explicit && adoption[field] === null) {
      warn(
        `json-api adapter: source '${source.id}' — default selector chain for '${field}' produced no value; consider setting jsonSelectors.${field} explicitly`,
      );
    }
  }

  // Build state. Prefer the server-supplied ETag; otherwise hash the page-0
  // body so re-runs without a server ETag still dedup correctly (mirrors the
  // html adapter's content-hash fallback).
  let nextEtag: string | undefined = previous?.lastEtag;
  if (lastEtag) {
    nextEtag = lastEtag;
  } else if (firstBodyText && firstBodyText.length > 0) {
    nextEtag = `${CONTENT_HASH_PREFIX}${createHash("sha256").update(firstBodyText).digest("hex")}`;
  }

  // Avoid unused-variable warnings while keeping `firstBody` available for
  // future debug surfaces (`source test` may want to print the first page
  // body when no items matched).
  void firstBody;

  // Compose diag payload for `source test --show-content`. The selector
  // adoption map reports the JSONPath candidate that won the fallback
  // chain per field (or the recipe-supplied path verbatim, or `null` when
  // every candidate missed). Pagination preview surfaces the next-URL /
  // Link / cursor extraction so users can spot misconfigurations without
  // letting the dry-run actually walk page 1.
  const selectorAdoption: Record<string, string | null> = {
    items: itemsPath ?? null,
    title: adoption.title ?? null,
    link: adoption.link ?? null,
    publishedAt: adoption.publishedAt ?? null,
    summary: adoption.summary ?? null,
  };
  const diag: FeedFetchDiag = {
    selectorAdoption,
    ...(paginationPreview ? { paginationPreview } : {}),
  };

  if (notModified) {
    return {
      items: [],
      notModified: true,
      state: {
        lastFetchedAt: fetchedAt,
        lastEtag: nextEtag,
      },
      diag,
    };
  }

  return {
    items,
    state: {
      lastFetchedAt: fetchedAt,
      lastEtag: nextEtag,
    },
    diag,
  };
}

/**
 * Public adapter. When `source.facets` is set, wraps {@link fetchSingle}
 * in an outer facet sweep loop (ADR-0017). Each iteration:
 *
 * - injects the facet value into the URL via {@link applyFacetValue}
 * - delegates to {@link fetchSingle} with `facets: undefined` so the
 *   inner traversal sees the modified URL but does not recurse
 * - disables conditional GET in facet sweep mode (ADR-0017 §State —
 *   per-facet ETag tracking is deferred to a future ADR)
 * - merges state.lastSeenIds globally across facet values (item IDs are
 *   unique across facets in the documented AWS What's New use case)
 *
 * Inner traversal semantics (`lastSeenIds` early-stop, `pagination.maxPages`
 * cap, `--max-pages` override, `--backfill` full traversal) apply unchanged
 * to each facet value. The outer loop walks every facet value in both
 * normal and `--backfill` modes — normal mode gets the early-stop benefit
 * inside each value but never skips a facet outright (that would silently
 * miss items in a facet whose first page has not changed since last run).
 *
 * Dry-run (`source test`) iterates only a single facet value so the
 * selector adoption preview is meaningful without walking every year:
 * range facets probe the upper bound (latest year, #256/#257) so recency
 * recipes verify keywords against current content; enum facets probe the
 * first value. The probed value is reported via `diag.facetSweep`.
 *
 * Phase 1 limitation: a single facet entry only. Multi-facet (e.g. year ×
 * category) requires composition rules that are out of scope here — see
 * ADR-0017 §Scope.
 */
export const jsonApiAdapter: FeedAdapter = {
  kind: "json-api",
  fetch: async (source: Source, options: FeedAdapterOptions = {}) => {
    if (!source.facets || Object.keys(source.facets).length === 0) {
      return fetchSingle(source, options);
    }

    const facetEntries = Object.entries(source.facets);
    if (facetEntries.length > 1) {
      // Phase 1 single-facet guard. The schema accepts a record shape for
      // forward-compat, but composing two axes (year × category) needs
      // explicit ordering / dedup semantics that ADR-0017 defers.
      throw new Error(
        `json-api adapter: source '${source.id}' declares ${facetEntries.length} facets — multi-facet sweep is not supported in Phase 1 (ADR-0017 §Scope)`,
      );
    }
    const [facetName, facetSpec] = facetEntries[0] as [string, SourceFacet];

    const dryRun = options.dryRun === true;
    // Aggregate items + lastSeenIds across every facet value. ETag is
    // intentionally NOT persisted: a single ETag cannot represent the
    // combined state of N facet values, and re-using last-run's ETag
    // would 304-out the next sweep. Per-facet ETag is future work.
    const aggregatedItems: Item[] = [];
    // `aggregatedSeen` is the *in-sweep* dedup/early-stop set, NOT a persisted
    // value: the facet adapter's returned `state` omits `lastSeenIds` (see the
    // `return` below), so the watcher — the sole persistence point — applies
    // the `maxSeenIds` FIFO cap (#333) when it builds `nextState`. We
    // deliberately do NOT trim `aggregatedSeen` here: it drives the per-facet
    // early-stop ("stop paging once we hit an already-seen id"), so dropping
    // ids mid-sweep would defeat that heuristic and re-emit already-seen items.
    const aggregatedSeen = new Set<string>(options.state?.lastSeenIds ?? []);
    let aggregatedDiag: FeedFetchDiag | undefined;
    let aggregatedNotModified = true;
    const fetchedAt = new Date().toISOString();

    // Dry-run (`source test`) probes exactly ONE facet value. For `range`
    // facets we pick the resolved upper bound (latest year) so recency-style
    // recipes are tested against current content — testing the range START
    // (oldest year, e.g. 2004) made keyword verification useless (#256).
    // `enum` facets keep first-value behaviour. The chosen value drives the
    // single iteration below and is reported via the `facetSweep` diag so the
    // CLI can warn that only one slice was exercised.
    const dryRunValue = dryRun ? pickDryRunFacetValue(facetSpec) : null;
    const facetSweepDiag: NonNullable<FeedFetchDiag["facetSweep"]> | undefined =
      dryRun && dryRunValue !== null
        ? {
            facet: facetName,
            param: facetSpec.param,
            testedValue: dryRunValue,
            type: facetSpec.type,
            totalValues: countFacetValues(facetSpec),
          }
        : undefined;

    // In dry-run mode iterate only the chosen value; otherwise walk the full
    // sweep. A degenerate range (`start > end`, i.e. `dryRunValue === null`)
    // yields nothing and falls through to an empty result.
    const valuesToWalk: Iterable<string | number> =
      dryRun && dryRunValue !== null ? [dryRunValue] : dryRun ? [] : generateFacetValues(facetSpec);

    // Per-page progress (#269): the inner pagination loop resets its page
    // counter on every facet value, so wrap `onPage` to stamp which value
    // (and its 1-based position in the sweep) each page event belongs to.
    // The CLI uses this to prefix the row with e.g. `year=2018 (15/23)`.
    const baseOnPage = options.onPage;
    const facetTotal = dryRun ? 1 : countFacetValues(facetSpec);
    let facetIndex = 0;

    for (const value of valuesToWalk) {
      facetIndex++;
      const innerUrl = applyFacetValue(source.url, facetSpec, value);
      // Build a "single-axis" view of the source: same id / pagination /
      // selectors but with the facet-stamped URL and `facets: undefined`
      // so the inner fetch does not recurse.
      const innerSource: Source = { ...source, url: innerUrl, facets: undefined };
      // Share the running lastSeenIds set with the inner fetch so the
      // per-facet early-stop heuristic dedupes against items already
      // observed in earlier facets. Conditional GET is disabled: each
      // facet value has its own ETag and re-using the previous value's
      // would silently 304-out the next slice.
      const innerOptions: FeedAdapterOptions = {
        ...options,
        onPage: baseOnPage
          ? (info) =>
              baseOnPage({
                ...info,
                facet: { name: facetName, value, index: facetIndex, total: facetTotal },
              })
          : undefined,
        state: options.state
          ? {
              ...options.state,
              lastEtag: undefined,
              lastSeenIds: Array.from(aggregatedSeen),
            }
          : {
              sourceId: source.id,
              lastSeenIds: Array.from(aggregatedSeen),
            },
      };

      const result = await fetchSingle(innerSource, innerOptions);
      // Capture the diag from the FIRST facet value only — it serves as
      // the representative selector-adoption / pagination-preview surface
      // for `source test`. Later iterations overwrite nothing.
      if (aggregatedDiag === undefined) aggregatedDiag = result.diag;
      if (!result.notModified) aggregatedNotModified = false;

      for (const item of result.items) {
        aggregatedItems.push(item);
        aggregatedSeen.add(item.id);
      }
    }

    // Fold the facet-sweep summary into the representative diag so
    // `source test` can warn which single value it probed. We attach it even
    // when the inner fetch produced no diag of its own (e.g. a degenerate
    // range yields no fetch at all but the sweep metadata is still useful).
    if (facetSweepDiag) {
      aggregatedDiag = { ...(aggregatedDiag ?? {}), facetSweep: facetSweepDiag };
    }

    return {
      items: aggregatedItems,
      // ADR-0017 §State: ETag disabled in facet sweep mode. Persist
      // `undefined` so the next run starts fresh.
      state: {
        lastFetchedAt: fetchedAt,
        lastEtag: undefined,
      },
      ...(aggregatedNotModified && aggregatedItems.length === 0 ? { notModified: true } : {}),
      ...(aggregatedDiag ? { diag: aggregatedDiag } : {}),
    };
  },
};
