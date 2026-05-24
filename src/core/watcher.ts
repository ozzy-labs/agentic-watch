import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createTranslator, type Translator } from "../i18n/index.js";
import type { Item, Source, SourceState } from "../schemas/index.js";
import { SourceSchema } from "../schemas/index.js";
import type { FeedAdapter, FeedFetchDiag, FetchLike } from "./feeds/index.js";
import { getFeedAdapter } from "./feeds/index.js";
import { filterItems } from "./filter.js";
import { detectInjection } from "./injection-detector.js";
import { saveItems } from "./items.js";
import {
  CHROMIUM_MISSING_HINT,
  installChromium,
  PLAYWRIGHT_MODULE_MISSING_HINT,
  type PlaywrightProbeResult,
  type ProbeOptions,
  probePlaywright,
} from "./playwright-check.js";
import type { ProgressReporter } from "./progress.js";
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
  /**
   * Backfill mode (ADR-0012 §D4): walk paginated sources to ingest all
   * available history into items/. Emits items AND updates state, unlike
   * `bootstrap` which only updates state. Mutually exclusive with
   * `bootstrap`; the CLI layer enforces the exclusivity, the watcher accepts
   * whichever flag was passed.
   */
  backfill?: boolean;
  /**
   * Override the per-source `pagination.maxPages` cap. Threaded straight
   * through to adapters that paginate (json-api / github-releases /
   * npm-registry). Only honored when `backfill` is true.
   */
  maxPagesOverride?: number;
  /**
   * Dry-run mode: run the full fetch + filter pipeline but do not persist
   * anything to disk — neither item YAMLs under `items/` nor the updated
   * `state/<sourceId>.yaml`. `WatchRunResult.detected` is still populated
   * with matched items so callers (e.g. `radar source test`) can preview
   * what would be ingested without mutating workspace state.
   *
   * Mutually independent from `bootstrap`: 304 and adapter / fetch error
   * paths are unchanged (no writes happen on those paths anyway).
   */
  dryRun?: boolean;
  /** Override the adapter registry (tests). */
  getAdapter?: (kind: Source["kind"]) => FeedAdapter;
  /** Override the HTTP fetcher (tests). */
  fetch?: FetchLike;
  /** Sinks for diagnostic output; defaults to console.* . */
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  /**
   * Override `process.env` lookup. Tests use this to toggle
   * `RADAR_AUTO_INSTALL_CHROMIUM=1` without poking at the real environment.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: replace the Playwright probe used by the lazy `html-js`
   * pre-check. Production callers leave this unset and the real
   * `import("playwright")` path runs.
   */
  playwrightProbeOptions?: ProbeOptions;
  /**
   * Test seam: replace the auto-install function. Tests inject a stub that
   * records invocation without actually spawning `npx playwright install`.
   */
  installChromiumImpl?: typeof installChromium;
  /**
   * Optional progress reporter for per-source fetch phases (#198 /
   * ADR-0015). The watcher gates wiring on a heuristic
   * ({@link shouldEnableProgress}) so the typical small / fast workspace
   * never sees flicker: progress is enabled only when at least 3 sources
   * run together OR any source uses a slow kind (`html-js` / `json-api`).
   *
   * When the reporter is unset (or the heuristic is off) every source runs
   * with no progress wiring — byte-equivalent to the pre-#198 behaviour.
   */
  progress?: ProgressReporter;
  /**
   * Translator for the user-facing watch-flow progress markers (#337 / ADR-0021).
   * Threaded alongside {@link progress} so the per-source page / completion
   * labels (and the html-js `Still waiting…` reminder) track the resolved UI
   * locale. Defaults to an `en` translator when unset so existing callers that
   * only care about the fetch mechanics keep their English output. The embedded
   * values (source id, page counters, mm:ss, item counts) are functional fields
   * and stay verbatim across locales.
   */
  translate?: Translator;
}

export interface WatchRunResult {
  /** Map of sourceId → detected (filter-passing, not previously seen) items. */
  detected: Record<string, Item[]>;
  /** Map of sourceId → the SourceState that was persisted after the run. */
  states: Record<string, SourceState>;
  /** Sources that errored during fetch/parse, so the CLI can exit non-zero. */
  errors: Array<{ sourceId: string; message: string }>;
  /**
   * Per-source pipeline counts. `fetched` is the raw item count returned by
   * the adapter (before filter / dedup), `filtered` is how many passed the
   * keyword filter. Populated for every source the run touched, including
   * `bootstrap` and `304 not modified` paths (where `filtered` is 0).
   *
   * Used primarily by `radar source test` (#133) to print a fetched / filtered
   * / matched summary; `radar watch run` does not need it for its current
   * stdout format but the field exists unconditionally to keep the result
   * shape stable across `dryRun` / non-`dryRun` callers.
   */
  stats: Record<string, { fetched: number; filtered: number }>;
  /**
   * Per-source diagnostic payload returned by adapters that produce one
   * (currently only `kind: json-api` — see `FeedFetchDiag`). Populated for
   * every source whose fetch returned a `diag` field; missing entries are
   * legal and indicate the adapter does not surface diagnostics.
   *
   * Consumers (`radar source test --show-content`) render this alongside
   * the matched-items preview so users can audit which default selector
   * chain candidate was adopted and how pagination would advance.
   */
  diag: Record<string, FeedFetchDiag>;
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
 * Heuristic: should the watcher actively report per-source progress to the
 * supplied {@link ProgressReporter}?
 *
 * The typical small workspace (1-2 RSS sources, ~3 seconds end-to-end)
 * gains nothing from a spinner that flashes in and out faster than the eye
 * can track. We therefore enable progress only when:
 *
 * 1. There are 3 or more sources to fetch in this run — at that scale the
 *    user wants per-source orientation as the loop iterates, OR
 * 2. Any source uses a slow kind — `html-js` (Playwright launch + render =
 *    seconds-to-tens-of-seconds) or `json-api` in `--backfill` mode
 *    (~80 page traversal). Even a single one of these makes the per-source
 *    indicator worth the noise.
 *
 * The heuristic is intentionally NOT user-configurable (ADR-0015 D5 /
 * issue #198 note). `--quiet` / `RADAR_NO_PROGRESS=1` are the documented
 * escape hatches when even the heuristic-on output is undesirable.
 *
 * Exported so the watcher / CLI can share one definition; tests pin
 * behaviour against this single source of truth.
 */
export function shouldEnableProgress(sources: Source[], backfill: boolean): boolean {
  if (sources.length >= 3) return true;
  for (const s of sources) {
    if (s.kind === "html-js") return true;
    if (s.kind === "json-api" && backfill) return true;
  }
  return false;
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
  const env = options.env ?? process.env;
  const installImpl = options.installChromiumImpl ?? installChromium;
  // Translator for the user-facing progress markers (#337). Defaults to `en`
  // so existing callers that do not pass a locale keep their English output.
  const t = options.translate ?? createTranslator("en");

  const sources = await loadSources(paths.sourcesDir, (m) => warn(`watch run: ${m}`));
  const filtered = options.sourceId ? sources.filter((s) => s.id === options.sourceId) : sources;

  if (filtered.length === 0) {
    if (options.sourceId) {
      warn(`watch run: no source with id '${options.sourceId}'`);
    } else {
      log("watch run: no sources defined (use `radar source add ...`)");
    }
    return { detected: {}, states: {}, errors: [], stats: {}, diag: {} };
  }

  const result: WatchRunResult = {
    detected: {},
    states: {},
    errors: [],
    stats: {},
    diag: {},
  };

  // Heuristic gate: only wire the reporter when the run is worth narrating.
  // Without this guard, `radar watch run` on a 1-source RSS workspace would
  // spam the spinner for ~3 seconds straight with no informational value.
  // `options.progress` being unset already means no output regardless.
  const progress =
    options.progress && shouldEnableProgress(filtered, options.backfill === true)
      ? options.progress
      : undefined;

  // Lazy Playwright probe cache. We only run the probe when the first
  // `html-js` source comes up so RSS / GitHub / npm-only workspaces never pay
  // for the dynamic import. The result is reused across every subsequent
  // `html-js` source in the same run — both because the install state cannot
  // realistically change mid-run and because re-probing per source would be
  // wasteful (and would spawn `npx playwright install` repeatedly when the
  // auto-install hatch is on but fails for some reason).
  let playwrightProbe: PlaywrightProbeResult | null = null;
  const ensurePlaywrightReady = async (): Promise<PlaywrightProbeResult> => {
    if (playwrightProbe !== null) return playwrightProbe;
    playwrightProbe = await probePlaywright(options.playwrightProbeOptions);
    // Auto-install escape hatch (CI-friendly, see playwright-check.ts policy).
    // Triggered only when (a) Playwright itself is present, (b) Chromium is
    // missing, and (c) the user opted in via env. We re-probe after install
    // so the cached result reflects post-install reality; if the install
    // failed the result stays at `chromium-missing` and the source is skipped
    // with the usual hint.
    if (playwrightProbe.status === "chromium-missing" && env.RADAR_AUTO_INSTALL_CHROMIUM === "1") {
      log("watch run: RADAR_AUTO_INSTALL_CHROMIUM=1 detected — attempting to install Chromium...");
      try {
        const code = await installImpl({ cwd: paths.cwd, log });
        if (code === 0) {
          playwrightProbe = await probePlaywright(options.playwrightProbeOptions);
        } else {
          warn(`watch run: chromium auto-install exited with code ${code}`);
        }
      } catch (e) {
        warn(
          `watch run: chromium auto-install failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return playwrightProbe;
  };

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

    // Lazy Playwright pre-check for `html-js` sources. Skipping the source
    // (rather than aborting the whole run) preserves the contract that one
    // misbehaving source must not block the others — the same shape used for
    // adapter errors / fetch failures above. The error message embeds the
    // canonical install hint so the user sees the same wording here as in
    // `radar doctor`.
    if (source.kind === "html-js") {
      const probe = await ensurePlaywrightReady();
      if (probe.status !== "ok") {
        const hint =
          probe.status === "module-missing"
            ? PLAYWRIGHT_MODULE_MISSING_HINT
            : CHROMIUM_MISSING_HINT;
        const detail =
          probe.status === "module-missing"
            ? "playwright module not installed"
            : `chromium binary missing at '${probe.executablePath}'`;
        const message = `${detail}\n${hint}`;
        error(`watch run: '${source.id}' skipped: ${message}`);
        result.errors.push({ sourceId: source.id, message });
        continue;
      }
    }
    let fetched: Item[];
    let nextStatePatch: Partial<SourceState>;
    let notModified = false;
    // Per-source phase markers (#198). `Fetching…` is the start-of-source
    // boundary the user sees in the spinner; the adapter may emit its own
    // sub-phases (html-js Chromium lifecycle, json-api page x/n) between
    // here and `Completed`. Side metrics for the spinner row default to
    // the source kind so even non-paginating adapters surface useful info.
    progress?.phase(`[${source.id}] Fetching…`, `kind: ${source.kind}`);
    progress?.start(`[${source.id}] ${source.kind}`);
    const sourceStartedAt = Date.now();
    try {
      const fetchResult = await adapter.fetch(source, {
        fetch: options.fetch,
        state: previousState,
        backfill: options.backfill,
        maxPagesOverride: options.maxPagesOverride,
        env: options.env,
        // In dry-run mode (`radar source test`), paginating adapters fetch
        // only page 0 so the preview never walks past the recipe's first
        // window. Non-paginating adapters ignore the flag.
        dryRun: options.dryRun,
        // Surface adapter-level non-fatal hints (default-selector misses on
        // json-api, etc.) through the same warn sink we use for
        // schema-mismatch / playwright-skip messages.
        warn: (m) => warn(`watch run: ${m}`),
        // Forward the source-scoped reporter so adapter phases nest under
        // the parent `[<source-id>] …` marker. html-js uses it for the
        // Chromium lifecycle; other kinds currently ignore it.
        onProgress: progress,
        // Thread the locale translator so the html-js `Still waiting…`
        // reminder is localized on the same path as the reporter (#337).
        translate: t,
        // Per-page hook for paginating adapters (json-api). We translate
        // each page event into a phase marker so non-TTY logs preserve the
        // narrative ("Page 3/80: 100 items") and TTY rows pick up the
        // metric on the spinner.
        onPage: progress
          ? ({ pageIndex, pageTotal, items: pageItems, facet }) => {
              // Facet sweep (ADR-0017) restarts pagination per facet value, so
              // the page counter resets to `1/N` each value. Prefix the facet
              // label (e.g. `year=2018 (15/23) `) so the repeated resets read as
              // sweep progress rather than a glitching counter (#269).
              const facetLabel = facet
                ? `${facet.name}=${facet.value} (${facet.index}/${facet.total}) `
                : "";
              progress.phase(
                t("cli.progress.watchPage", {
                  sourceId: source.id,
                  facet: facetLabel,
                  page: pageIndex + 1,
                  pageTotal,
                  items: pageItems,
                }),
              );
              progress.update({
                ...(facet
                  ? { [facet.name]: `${facet.value} (${facet.index}/${facet.total})` }
                  : {}),
                page: `${pageIndex + 1}/${pageTotal}`,
                items: String(pageItems),
              });
            }
          : undefined,
      });
      fetched = fetchResult.items;
      nextStatePatch = fetchResult.state;
      notModified = fetchResult.notModified ?? false;
      if (fetchResult.diag) {
        result.diag[source.id] = fetchResult.diag;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      progress?.fail(`[${source.id}] Failed`, message);
      error(`watch run: '${source.id}' fetch failed: ${message}`);
      result.errors.push({ sourceId: source.id, message });
      continue;
    }

    const seenIds = new Set(previousState.lastSeenIds);
    let detectedItems: Item[] = [];
    // `filteredCount` is the number of items that passed the keyword filter
    // *before* lastSeenIds dedup. Surfaced through `result.stats` so callers
    // like `radar source test` can show users a fetched / filtered / matched
    // breakdown without re-running the pipeline. Bootstrap / 304 paths leave
    // it at 0 because no filter ran.
    let filteredCount = 0;

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
      filteredCount = passed.length;
      const fresh = passed
        .filter((item) => !seenIds.has(item.id))
        .map((item) => annotateInjectionFlags(item));
      if (fresh.length > 0) {
        // Dry-run mode (e.g. `radar source test`): preview matches without
        // writing item YAMLs. We still record the ids in the working
        // `seenIds` set below so the in-memory `nextState` is consistent,
        // but `saveSourceState` is skipped further down so nothing leaks
        // to disk.
        if (!options.dryRun) {
          await saveItems(paths.itemsDir, fresh);
        }
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
      // hits; the per-item view is available via `radar research` /
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
      lastModified: nextStatePatch.lastModified ?? previousState.lastModified,
      lastSeenIds: Array.from(seenIds),
    };
    // In dry-run mode we still surface the would-be state through
    // `result.states` so callers can introspect the projected delta, but we
    // never persist it.
    if (!options.dryRun) {
      await saveSourceState(paths.stateDir, nextState);
    }
    result.detected[source.id] = detectedItems;
    result.states[source.id] = nextState;
    result.stats[source.id] = { fetched: fetched.length, filtered: filteredCount };

    // Per-source completion phase. We use the reporter's `succeed()` so the
    // spinner row stops cleanly and the user gets a single summary line
    // (`[<source-id>] Completed: <items> total, <new> new (<duration>)`).
    // The legacy plain log lines further up the loop are intentionally
    // preserved (acceptance criterion #7) so scripts that grep stdout
    // continue to work.
    if (progress) {
      const duration = Date.now() - sourceStartedAt;
      progress.succeed(
        t("cli.progress.watchSourceCompleted", {
          sourceId: source.id,
          total: fetched.length,
          fresh: detectedItems.length,
        }),
        duration,
      );
    }
  }

  return result;
}

/**
 * Legacy convenience: fetch every source serially without any state I/O.
 *
 * Kept for callers that just want the raw items (e.g. the placeholder
 * `radar watch` invocation). The real CLI now goes through
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
