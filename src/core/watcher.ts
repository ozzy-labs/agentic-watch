import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Item, Source, SourceState } from "../schemas/index.js";
import { SourceSchema } from "../schemas/index.js";
import type { FeedAdapter, FetchLike } from "./feeds/index.js";
import { getFeedAdapter } from "./feeds/index.js";
import { filterItems } from "./filter.js";
import { detectInjection } from "./injection-detector.js";
import { saveItems } from "./items.js";
import { loadSourceState, saveSourceState } from "./state.js";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the injection pre-filter (ADR-0009 M1a — Adopt) over an item's
 * untrusted text fields and return the item with `injectionFlags` populated.
 *
 * Coverage: `title`, `summary`, and `raw`. The `raw` payload is structured
 * (varies by adapter — RSS / Atom / npm / HTML), so we `JSON.stringify` it so
 * embedded strings are still scanned without forcing each adapter to know
 * about the detector. Fields that are unset / empty contribute nothing.
 *
 * Audit-only: the flags are recorded for later inspection by `research` /
 * `review` / `update` and surface in CLI logs. We do NOT mutate `status`,
 * sanitize content, or drop items — that aligns with ADR-0009 M5a (Adopt /
 * user retains judgment) and M5b (Reject — no auto-drop).
 */
function annotateInjectionFlags(item: Item): Item {
  const parts: string[] = [item.title];
  if (item.summary) parts.push(item.summary);
  if (item.raw !== undefined) {
    try {
      parts.push(JSON.stringify(item.raw));
    } catch {
      // Circular / unserializable raw payload — fall back to a coarse string
      // cast so we still scan something rather than silently skip.
      parts.push(String(item.raw));
    }
  }
  const haystack = parts.join("\n");
  const { matched } = detectInjection(haystack);
  return { ...item, injectionFlags: matched };
}

export interface WorkspacePaths {
  /** Workspace root; defaults to process.cwd() at the CLI layer. */
  cwd: string;
  sourcesDir?: string;
  itemsDir?: string;
  stateDir?: string;
}

export interface WatchRunOptions extends WorkspacePaths {
  /** Limit the run to a single source id. Defaults to all sources. */
  sourceId?: string;
  /**
   * Bootstrap mode: ingest all current entries into `lastSeenIds` without
   * emitting any items. Used on first install to suppress noise from existing
   * backlogs (ADR-0008 §運用: 初回ノイズ抑制).
   */
  bootstrap?: boolean;
  /** Override the adapter registry (tests). */
  getAdapter?: (kind: Source["kind"]) => FeedAdapter;
  /** Override the HTTP fetcher (tests). */
  fetch?: FetchLike;
  /** Sinks for diagnostic output; defaults to console.* . */
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface WatchRunResult {
  /** Map of sourceId → detected (filter-passing, not previously seen) items. */
  detected: Record<string, Item[]>;
  /** Map of sourceId → the SourceState that was persisted after the run. */
  states: Record<string, SourceState>;
  /** Sources that errored during fetch/parse, so the CLI can exit non-zero. */
  errors: Array<{ sourceId: string; message: string }>;
}

function defaultPaths(opts: WorkspacePaths): Required<WorkspacePaths> {
  return {
    cwd: opts.cwd,
    sourcesDir: opts.sourcesDir ?? join(opts.cwd, "sources"),
    itemsDir: opts.itemsDir ?? join(opts.cwd, "items"),
    stateDir: opts.stateDir ?? join(opts.cwd, "state"),
  };
}

/**
 * Load all enabled sources from `sources/*.yaml`.
 *
 * Malformed files are reported through `onError` but do not abort the load —
 * one broken YAML should not block the entire run, mirroring how `source list`
 * behaves (see `src/cli/source.ts`).
 */
export async function loadSources(
  sourcesDir: string,
  onError: (message: string) => void,
): Promise<Source[]> {
  if (!(await pathExists(sourcesDir))) return [];
  const entries = await readdir(sourcesDir);
  const yamlFiles = entries.filter((f) => f.endsWith(".yaml")).sort();
  const sources: Source[] = [];
  for (const filename of yamlFiles) {
    const file = join(sourcesDir, filename);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      onError(`failed to read ${filename}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      onError(`invalid YAML in ${filename}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const result = SourceSchema.safeParse(parsed);
    if (!result.success) {
      onError(`schema mismatch in ${filename}: ${result.error.issues[0]?.message ?? "unknown"}`);
      continue;
    }
    sources.push(result.data);
  }
  return sources;
}

/**
 * Execute one full watch cycle.
 *
 * Per source:
 *   1. Load previous state (`state/<id>.yaml`).
 *   2. Invoke the feed adapter with the previous ETag.
 *   3. Filter freshly-fetched items.
 *   4. Subtract anything in `lastSeenIds`.
 *   5. In bootstrap mode, persist *all* fetched ids to seen without emitting
 *      items. Otherwise, write the new items to `items/<sourceId>/` and merge
 *      their ids into `lastSeenIds`.
 *   6. Persist `state/<sourceId>.yaml`.
 *
 * Step 4 + 5 ensure idempotency: re-running the watcher does not produce
 * duplicate item files. ADR-0006 filter semantics are applied in step 3.
 */
export async function watchRun(options: WatchRunOptions): Promise<WatchRunResult> {
  const paths = defaultPaths(options);
  const log = options.log ?? ((m: string) => console.log(m));
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const error = options.error ?? ((m: string) => console.error(m));
  const getAdapter = options.getAdapter ?? getFeedAdapter;

  const sources = await loadSources(paths.sourcesDir, (m) => warn(`watch run: ${m}`));
  const filtered = options.sourceId ? sources.filter((s) => s.id === options.sourceId) : sources;

  if (filtered.length === 0) {
    if (options.sourceId) {
      warn(`watch run: no source with id '${options.sourceId}'`);
    } else {
      log("watch run: no sources defined (use `agentic-watch source add ...`)");
    }
    return { detected: {}, states: {}, errors: [] };
  }

  const result: WatchRunResult = { detected: {}, states: {}, errors: [] };

  for (const source of filtered) {
    const previousState = await loadSourceState(paths.stateDir, source.id);
    let adapter: FeedAdapter;
    try {
      adapter = getAdapter(source.kind);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error(`watch run: '${source.id}' adapter error: ${message}`);
      result.errors.push({ sourceId: source.id, message });
      continue;
    }
    let fetched: Item[];
    let nextStatePatch: Partial<SourceState>;
    let notModified = false;
    try {
      const fetchResult = await adapter.fetch(source, {
        fetch: options.fetch,
        state: previousState,
      });
      fetched = fetchResult.items;
      nextStatePatch = fetchResult.state;
      notModified = fetchResult.notModified ?? false;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error(`watch run: '${source.id}' fetch failed: ${message}`);
      result.errors.push({ sourceId: source.id, message });
      continue;
    }

    const seenIds = new Set(previousState.lastSeenIds);
    let detectedItems: Item[] = [];

    if (options.bootstrap) {
      // Bootstrap: seed the state with every id we saw so the *next* run can
      // diff against it. We intentionally skip filter + emit so the user does
      // not get blasted with historical detections (ADR-0008 §運用 hint).
      for (const item of fetched) seenIds.add(item.id);
      log(`watch run: bootstrap '${source.id}' — ${fetched.length} ids recorded, no items written`);
    } else if (notModified) {
      log(`watch run: '${source.id}' unchanged (304)`);
    } else {
      const passed = filterItems(fetched, source);
      const fresh = passed
        .filter((item) => !seenIds.has(item.id))
        .map((item) => annotateInjectionFlags(item));
      if (fresh.length > 0) {
        await saveItems(paths.itemsDir, fresh);
        for (const item of fresh) seenIds.add(item.id);
      }
      // Always add every fetched id to seen — even items that failed the
      // filter should not be re-evaluated next run, since the filter result
      // would not change without a content change (and we already keep the
      // raw payload for any item that did pass).
      for (const item of fetched) seenIds.add(item.id);
      detectedItems = fresh;
      // Diagnose the most common "why are 0 items new?" pitfall: a source
      // with no include keywords. `src/core/filter.ts` short-circuits to
      // `match nothing` in that case (firehose guard), so fetched-but-zero
      // is otherwise indistinguishable from "feed unchanged". The hint
      // points the user at the YAML file they need to edit to fix it.
      if (fetched.length > 0 && fresh.length === 0 && source.filters.keywords.length === 0) {
        warn(
          `watch run: '${source.id}' has no keywords configured — all ${fetched.length} fetched item(s) were filtered out. Add keywords to sources/${source.id}.yaml to start ingesting.`,
        );
      }
      log(
        `watch run: '${source.id}' fetched ${fetched.length} items, ${fresh.length} new after filter`,
      );
      // Surface a per-source audit summary for items that tripped the
      // injection pre-filter (ADR-0009 M1a). We log once per source rather
      // than per item to keep the watch output readable when a feed has many
      // hits; the per-item view is available via `agentic-watch research` /
      // `review` / `update` logs and in `items/<id>.yaml` directly.
      const flagged = fresh.filter((i) => i.injectionFlags.length > 0);
      if (flagged.length > 0) {
        warn(
          `watch run: '${source.id}' ${flagged.length} item(s) tripped the prompt-injection pre-filter (audit-only; status unchanged). See injectionFlags in items/<id>.yaml.`,
        );
      }
    }

    const nextState: SourceState = {
      sourceId: source.id,
      lastFetchedAt: nextStatePatch.lastFetchedAt ?? previousState.lastFetchedAt,
      lastEtag: nextStatePatch.lastEtag ?? previousState.lastEtag,
      lastSeenIds: Array.from(seenIds),
    };
    await saveSourceState(paths.stateDir, nextState);
    result.detected[source.id] = detectedItems;
    result.states[source.id] = nextState;
  }

  return result;
}

/**
 * Legacy convenience: fetch every source serially without any state I/O.
 *
 * Kept for callers that just want the raw items (e.g. the placeholder
 * `agentic-watch watch` invocation). The real CLI now goes through
 * `watchRun`, which threads state and filters.
 */
export async function watch(sources: Source[]): Promise<Item[]> {
  const results: Item[] = [];
  for (const source of sources) {
    const adapter = getFeedAdapter(source.kind);
    const { items } = await adapter.fetch(source);
    results.push(...items);
  }
  return results;
}
