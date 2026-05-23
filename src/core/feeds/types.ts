import type { Item, Source, SourceState } from "../../schemas/index.js";
import type { ProgressReporter } from "../progress.js";

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
  /**
   * Facet-sweep summary surfaced when a `kind: json-api` source declares
   * `facets:` (ADR-0017) and the fetch ran in dry-run mode (`source test`).
   *
   * A dry run walks exactly ONE facet value — the rest of the sweep is
   * skipped to keep the preview cheap. This payload tells `source test`
   * which value was actually probed so the CLI can warn the user that
   * keyword verification only reflects that single slice (e.g. a year-axis
   * recipe whose other years are not exercised). For `range` facets the
   * probed value is the resolved upper bound (latest year, #256/#257) so
   * recency-style recipes are tested against current content rather than
   * the historical first year; `enum` facets use the first listed value
   * (no "latest" concept).
   */
  facetSweep?: {
    /** The facet name (the key in `source.facets`). */
    facet: string;
    /** The injected query parameter (`facet.param`). */
    param: string;
    /** The single facet value actually fetched in this dry run. */
    testedValue: string | number;
    /** The facet discriminator (`range` | `enum`). */
    type: string;
    /** Total number of facet values a real (non-dry-run) sweep would walk. */
    totalValues: number;
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
  /**
   * Optional progress reporter for long-running fetches (ADR-0015 D3 / #198).
   *
   * - `kind: html-js` calls `phase()` around Playwright Chromium lifecycle
   *   (`Launching Chromium…` / `Navigating to <url>…` / `Waiting for
   *   selector "<sel>" (timeout: <ms>ms)…` / `Capturing page content…` /
   *   `Closing browser…`).
   * - `kind: json-api` in `--backfill` mode fires page-level progress via
   *   {@link FeedAdapterOptions.onPage} (see below) and uses `phase()` for
   *   one-shot start/stop markers.
   * - Other adapters (rss / atom / html / github-releases / npm-registry)
   *   currently ignore the reporter — fetches complete in a single
   *   short-lived HTTP round trip with no meaningful intermediate phase.
   *
   * Unset is byte-equivalent to the pre-#198 behaviour (no progress output).
   */
  onProgress?: ProgressReporter;
  /**
   * Per-page progress callback for paginating adapters (json-api / future
   * github-releases / npm-registry). Fired after each page is fetched and
   * normalized so the watcher / CLI can update a `Page <i>/<n>: <items>`
   * spinner row without the adapter needing to know about the
   * `ProgressReporter` shape.
   *
   * - `pageIndex` is 0-based (page 0 = the first response).
   * - `pageTotal` is the recipe-implied cap (`pagination.maxPages` or
   *   `--max-pages`); when `totalPath` resolves on page 0 it tightens
   *   further so the user sees a meaningful denominator instead of the
   *   conservative cap.
   * - `items` is the count of items extracted from this page (post-schema
   *   validation, pre-filter / pre-dedup).
   *
   * Unset means no per-page callback. Independent of `onProgress`: callers
   * that want the spinner but not per-page metrics can wire one and not the
   * other.
   */
  onPage?: (info: { pageIndex: number; pageTotal: number; items: number }) => void;
}

export interface FeedAdapter {
  kind: Source["kind"];
  fetch: (source: Source, options?: FeedAdapterOptions) => Promise<FeedFetchResult>;
}
