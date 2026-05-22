import type { Item, Source, SourceState } from "../../schemas/index.js";

/**
 * Minimal `fetch` signature an adapter needs.
 *
 * Defined narrowly so tests can inject a stub without bringing the entire
 * `globalThis.fetch` type surface along. Node 22+'s built-in fetch satisfies
 * this shape.
 */
export type FetchLike = (
  input: string | URL,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Per-fetch diagnostic information surfaced by an adapter for tooling
 * (`radar source test --show-content`), never persisted to state/items.
 *
 * Currently used by `kind: json-api` to expose which fallback selector
 * matched per field (so users can audit the default-chain decision) and how
 * pagination would advance (`Link` header / `nextCursor` extraction) without
 * the dry-run actually walking past page 0.
 */
export interface FeedFetchDiag {
  /**
   * For each output field (`items`, `title`, `link`, `publishedAt`,
   * `summary`), the JSONPath expression the adapter ended up using. The
   * value is either the path from the recipe (when explicit) or a default
   * chain candidate (when fallback). `null` means "all candidates returned
   * undefined" — useful for debugging totally-unmapped fields.
   */
  selectorAdoption?: Record<string, string | null>;
  /**
   * Pagination preview surfaced from page 0 only. Lets `source test` show
   * whether the recipe's `pagination` block would advance correctly without
   * actually fetching page 1 (which would mutate state on real runs).
   */
  paginationPreview?: {
    /** The pagination strategy declared by the recipe. */
    strategy: string;
    /** Computed next-page URL (or null when traversal would end here). */
    nextUrl: string | null;
    /** `Link: <...>; rel="next"` parse result, when strategy is `link-header`. */
    linkHeaderNext?: string | null;
    /** Cursor / token value extracted from `nextCursorPath`, when applicable. */
    nextCursor?: string | null;
  };
}

/** Result of a single adapter fetch — the items plus the next state to persist. */
export interface FeedFetchResult {
  items: Item[];
  /**
   * Patch to merge into the source's `SourceState`. Adapters return only the
   * fields they want to update so the watcher can decide how to merge with the
   * existing on-disk state (e.g. unioning `lastSeenIds`).
   */
  state: Partial<SourceState>;
  /**
   * `true` when the upstream returned 304 Not Modified (or an equivalent
   * unchanged response). Watcher uses this to short-circuit item processing
   * while still bumping `lastFetchedAt`.
   */
  notModified?: boolean;
  /**
   * Optional diagnostic payload. Adapters fill this in when they have useful
   * tooling info (json-api's selector adoption + pagination preview); other
   * adapters leave it undefined. The watcher propagates it to
   * `WatchRunResult.diag[sourceId]` so `source test` can render it.
   */
  diag?: FeedFetchDiag;
}

export interface FeedAdapterOptions {
  /** Caller-supplied fetch (defaults to global fetch). Injected by tests. */
  fetch?: FetchLike;
  /** Previous state for this source (`state/<id>.yaml`). */
  state?: SourceState;
  /**
   * Backfill hint (ADR-0012 §D4). When true, adapters that support page
   * traversal walk all available history pages until `pagination.maxPages`
   * (or `maxPagesOverride`) is exhausted, emitting items rather than only
   * the most-recent page. The watcher / CLI propagates this from
   * `radar watch run --backfill`.
   *
   * Adapters that do not support backfill (rss / html / html-js — feed
   * formats with no pagination contract) simply ignore the flag.
   */
  backfill?: boolean;
  /**
   * Optional override for the per-source `pagination.maxPages` cap. Used by
   * `--max-pages N` to widen / narrow the backfill traversal without editing
   * the source YAML. Adapters that do not paginate ignore this field.
   */
  maxPagesOverride?: number;
  /**
   * Environment lookup for `${VAR}` interpolation inside `http.headers`
   * (json-api adapter, ADR-0012 §D5c). Defaults to `process.env`; tests
   * inject a controlled record so credential-shaped values never escape into
   * test output / fixtures.
   */
  env?: Record<string, string | undefined>;
  /**
   * Dry-run hint (#174). When true, paginating adapters fetch only page 0
   * (preserving the `radar source test` "no state mutation" contract for
   * `kind: json-api` where pagination would otherwise walk multiple pages).
   * Adapters that do not paginate ignore the flag. Tooling can inspect the
   * computed next-page URL via `FeedFetchResult.diag.paginationPreview`
   * without an extra round-trip.
   */
  dryRun?: boolean;
  /**
   * Diagnostic warning sink (#174). Adapters call this for non-fatal
   * surprises like "all default selector candidates resolved to null". The
   * watcher / CLI route it to `console.warn` so users notice. Defaults to
   * a no-op when unset.
   */
  warn?: (message: string) => void;
}

export interface FeedAdapter {
  kind: Source["kind"];
  fetch: (source: Source, options?: FeedAdapterOptions) => Promise<FeedFetchResult>;
}
