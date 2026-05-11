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
}

export interface FeedAdapterOptions {
  /** Caller-supplied fetch (defaults to global fetch). Injected by tests. */
  fetch?: FetchLike;
  /** Previous state for this source (`state/<id>.yaml`). */
  state?: SourceState;
}

export interface FeedAdapter {
  kind: Source["kind"];
  fetch: (source: Source, options?: FeedAdapterOptions) => Promise<FeedFetchResult>;
}
