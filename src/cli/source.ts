import { access, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { FetchLike } from "../core/feeds/types.js";
import { loadSourceState } from "../core/state.js";
import { type WatchRunResult, watchRun } from "../core/watcher.js";
import type { Source } from "../schemas/source.js";
import { SourceKindSchema, SourceSchema, SourceSelectorsSchema } from "../schemas/source.js";
import type { Command } from "./index.js";

/**
 * Sinks for the source command's user-facing output.
 *
 * The CLI binds these to `console.*` by default; tests inject capturing sinks
 * to assert against printed lines without poking at stdio.
 *
 * `warn` is separate from `error` so non-fatal hints (e.g. "no keywords
 * configured — items will be filtered out") still surface on stderr without
 * affecting the exit code or being treated as a hard failure by callers.
 */
export interface SourceIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** Options accepted across all `source` subcommands. */
export interface SourceCommandOptions {
  /** Workspace root (defaults to `process.cwd()` for the real CLI). */
  cwd?: string;
  io?: SourceIO;
  /**
   * Test seam: override the HTTP fetcher used by `source test`. Only the
   * `test` subcommand currently needs it (it goes through `watchRun`); the
   * field is declared here so `runSource` can forward the same options bag
   * uniformly to every dispatcher branch.
   */
  fetch?: FetchLike;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function sourcesDir(cwd: string): string {
  return join(cwd, "sources");
}

function sourceFile(cwd: string, id: string): string {
  return join(sourcesDir(cwd), `${id}.yaml`);
}

function stateDir(cwd: string): string {
  return join(cwd, "state");
}

/**
 * Validate a source id as a safe filename component.
 *
 * Rejecting path separators, leading dots, and shell-unsafe characters keeps
 * `sources/<id>.yaml` from escaping the sources/ directory or producing
 * surprising paths. The CLI is single-user but ids may flow from copy-pasted
 * URLs or scripted inputs, so a conservative regex avoids footguns.
 */
function isSafeSourceId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
}

/** Split a comma-separated CLI argument into trimmed, non-empty tokens. */
function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface AddArgs {
  id?: string;
  kind?: string;
  url?: string;
  name?: string;
  tags?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  /**
   * `--selector-<field> <css>` accumulator. We collect raw key/value pairs
   * here and let the SourceSelectorsSchema reject unknown fields, so the CLI
   * stays in sync with the schema without a parallel allowlist.
   */
  selectors?: Record<string, string>;
  help?: boolean;
}

/**
 * Parse `source add` flags.
 *
 * Throws on flags that require a value but receive none, or on unknown flags.
 * Returning structured data keeps run() free of argument-parsing branches.
 */
function parseAddArgs(args: string[]): AddArgs {
  const out: AddArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--kind") {
      out.kind = args[++i];
      continue;
    }
    if (a === "--url") {
      out.url = args[++i];
      continue;
    }
    if (a === "--name") {
      out.name = args[++i];
      continue;
    }
    if (a === "--tags") {
      out.tags = splitCsv(args[++i] ?? "");
      continue;
    }
    if (a === "--keywords") {
      out.keywords = splitCsv(args[++i] ?? "");
      continue;
    }
    if (a === "--exclude-keywords") {
      out.excludeKeywords = splitCsv(args[++i] ?? "");
      continue;
    }
    if (a?.startsWith("--selector-")) {
      // `--selector-<field> <css>` — e.g. `--selector-item "article.entry"`.
      // Field validity (item / title / link / summary / publishedAt / body /
      // tags) is enforced by SourceSelectorsSchema at parse time, so unknown
      // fields surface as a normal validation error instead of being silently
      // swallowed here.
      const field = a.slice("--selector-".length);
      if (!field) throw new Error(`unknown option: ${a}`);
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.selectors ??= {};
      out.selectors[field] = value;
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (!out.id) {
      out.id = a;
      continue;
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

interface ListArgs {
  enabledOnly?: boolean;
  /**
   * Verbose mode prints a per-source block including keywords / trustLevel /
   * lastFetchedAt instead of the default 4-column table. Toggled via
   * `--verbose` or the short `-v` alias.
   */
  verbose?: boolean;
  help?: boolean;
}

function parseListArgs(args: string[]): ListArgs {
  const out: ListArgs = {};
  for (const a of args) {
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--enabled-only") {
      out.enabledOnly = true;
      continue;
    }
    if (a === "-v" || a === "--verbose") {
      out.verbose = true;
      continue;
    }
    throw new Error(`unknown option: ${a}`);
  }
  return out;
}

interface TestArgs {
  id?: string;
  /** `--limit N` cap on how many matched items to print. Default 10. */
  limit?: number;
  /** `--show-content` toggle for printing first 200 chars of the body. */
  showContent?: boolean;
  help?: boolean;
}

/**
 * Parse `source test` flags.
 *
 * Mirrors `parseAddArgs` in shape: structured return + throw on malformed
 * input. `--limit` is validated as a non-negative integer so we fail at parse
 * time instead of slicing with `NaN` later.
 */
function parseTestArgs(args: string[]): TestArgs {
  const out: TestArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--limit") {
      const raw = args[++i];
      if (raw === undefined) throw new Error("option --limit requires a value");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`option --limit expects a non-negative integer, got '${raw}'`);
      }
      out.limit = n;
      continue;
    }
    if (a === "--show-content") {
      out.showContent = true;
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (!out.id) {
      out.id = a;
      continue;
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

interface RemoveArgs {
  id?: string;
  help?: boolean;
}

function parseRemoveArgs(args: string[]): RemoveArgs {
  const out: RemoveArgs = {};
  for (const a of args) {
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (!out.id) {
      out.id = a;
      continue;
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

function printAddHelp(log: (m: string) => void): void {
  log("Usage: radar source add <id> --kind <kind> --url <url> [options]");
  log("");
  log("Options:");
  log(
    "  --kind <kind>            rss | html | html-js | github-releases | npm-registry | json-api",
  );
  log("  --url <url>              fetch target URL");
  log("  --name <name>            display name (defaults to <id>)");
  log("  --tags <a,b>             comma-separated tags");
  log("  --keywords <a,b>         comma-separated include keywords");
  log("                           (required for useful output — empty = match nothing)");
  log("  --exclude-keywords <a,b> comma-separated exclude keywords");
  log(
    "  --selector-<field> <css> CSS selector for kind=html / html-js (required: item, title, link)",
  );
  log("                           optional: summary, publishedAt, body, tags");
  log("                           For kind=html-js, selectors evaluate against the post-JS DOM.");
  log("                           The `js:` block (waitFor / timeout / userAgent) cannot be set");
  log("                           via flags; edit sources/<id>.yaml after add. See ADR-0010.");
  log("");
  log("                           For kind=json-api, edit sources/<id>.yaml after `add` to set");
  log(
    "                           the `pagination:` / `jsonSelectors:` / `http:` blocks (ADR-0012).",
  );
}

function printListHelp(log: (m: string) => void): void {
  log("Usage: radar source list [--enabled-only] [-v|--verbose]");
  log("");
  log("Lists sources/*.yaml in tabular form: id / kind / url / tags.");
  log("");
  log("Options:");
  log("  --enabled-only   Reserved for forward compatibility (currently a no-op).");
  log("  -v, --verbose    Print a detailed block per source including keywords,");
  log("                   trustLevel, and lastFetchedAt (from state/<id>.yaml).");
}

function printRemoveHelp(log: (m: string) => void): void {
  log("Usage: radar source remove <id>");
  log("");
  log("Deletes sources/<id>.yaml. state/<id>.yaml and items/ are preserved.");
}

function printTestHelp(log: (m: string) => void): void {
  log("Usage: radar source test <id> [--limit N] [--show-content]");
  log("");
  log("Dry-run a single source: fetch, filter, and print matched items.");
  log("state/ and items/ are not touched (no persistence). Useful for tuning");
  log("keywords when adding a new source.");
  log("");
  log("Options:");
  log("  --limit N        Maximum number of matched items to print (default 10)");
  log("  --show-content   Also print the first 200 characters of each item's body");
}

function printSourceHelp(log: (m: string) => void): void {
  log("Usage: radar source <add|list|remove|test> [...]");
  log("");
  log("Subcommands:");
  log("  add <id> --kind <kind> --url <url> [...]");
  log("  list [--enabled-only]");
  log("  remove <id>");
  log("  test <id> [--limit N] [--show-content]");
}

/**
 * Implementation of `source add`.
 *
 * Builds a Source object from CLI flags, validates it with the Zod schema, and
 * writes `sources/<id>.yaml`. Refuses to overwrite an existing file (issue #12
 * explicitly forbids `--force`-style escape hatches; YAML edits remain the
 * supported workflow for mutation).
 */
export async function addSource(
  args: string[],
  options: SourceCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  let parsed: AddArgs;
  try {
    parsed = parseAddArgs(args);
  } catch (e) {
    error(`source add: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printAddHelp(log);
    return 0;
  }
  if (!parsed.id) {
    error("source add: missing <id>");
    printAddHelp(error);
    return 2;
  }
  if (!isSafeSourceId(parsed.id)) {
    error(`source add: invalid <id> '${parsed.id}' (must match [A-Za-z0-9][A-Za-z0-9._-]*)`);
    return 2;
  }
  if (!parsed.kind) {
    error("source add: --kind is required");
    return 2;
  }
  if (!parsed.url) {
    error("source add: --url is required");
    return 2;
  }

  const kindResult = SourceKindSchema.safeParse(parsed.kind);
  if (!kindResult.success) {
    error(
      `source add: invalid --kind '${parsed.kind}' (expected: rss | html | html-js | github-releases | npm-registry | json-api)`,
    );
    return 2;
  }

  // Compose the object before schema validation so url-format errors et al.
  // surface through Zod (single source of truth for shape rules).
  const candidate: Record<string, unknown> = {
    id: parsed.id,
    kind: kindResult.data,
    url: parsed.url,
  };
  if (parsed.name) candidate.name = parsed.name;
  if (parsed.tags && parsed.tags.length > 0) candidate.tags = parsed.tags;
  if (
    (parsed.keywords && parsed.keywords.length > 0) ||
    (parsed.excludeKeywords && parsed.excludeKeywords.length > 0)
  ) {
    const filters: Record<string, unknown> = {};
    if (parsed.keywords && parsed.keywords.length > 0) filters.keywords = parsed.keywords;
    if (parsed.excludeKeywords && parsed.excludeKeywords.length > 0) {
      filters.excludeKeywords = parsed.excludeKeywords;
    }
    candidate.filters = filters;
  }
  if (parsed.selectors) {
    // Validate selector shape early so the user sees a single targeted error
    // ("selectors.item: required") instead of the refinement-level "selectors
    // is required when kind is 'html'" further down.
    const selectorsResult = SourceSelectorsSchema.safeParse(parsed.selectors);
    if (!selectorsResult.success) {
      const issues = selectorsResult.error.issues.map(
        (i) => `selectors.${i.path.join(".") || "<root>"}: ${i.message}`,
      );
      error(`source add: validation failed`);
      for (const issue of issues) {
        error(`  - ${issue}`);
      }
      return 2;
    }
    candidate.selectors = selectorsResult.data;
  }

  const validated = SourceSchema.safeParse(candidate);
  if (!validated.success) {
    const issues = validated.error.issues.map(
      (i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
    );
    error(`source add: validation failed`);
    for (const issue of issues) {
      error(`  - ${issue}`);
    }
    return 2;
  }

  const file = sourceFile(cwd, validated.data.id);
  if (await pathExists(file)) {
    error(`source add: '${validated.data.id}' already exists (sources/${validated.data.id}.yaml)`);
    return 1;
  }

  await writeFile(file, stringifyYaml(validated.data), "utf8");
  log(`source add: created sources/${validated.data.id}.yaml`);

  // ADR-0006 / src/core/filter.ts treats an empty include-keyword list as
  // "match nothing" (firehose guard). A source with no keywords is therefore
  // valid YAML but inert — `watch run` will fetch it and drop every item
  // before disk. Surface a hint here so the user is not left wondering why
  // their feed appears silent later. We emit the hint as a non-fatal warning
  // (stderr) so scripts that parse stdout are unaffected and the exit code
  // stays 0.
  if (validated.data.filters.keywords.length === 0) {
    warn(
      `source add: warning — '${validated.data.id}' has no keywords; all fetched items will be filtered out. Edit sources/${validated.data.id}.yaml or re-add with --keywords to start ingesting.`,
    );
  }

  return 0;
}

/**
 * Load and validate a single `sources/<id>.yaml` file. Returns `null` and
 * reports through `onError` when the file is malformed, so `list` can keep
 * going across other entries.
 */
async function readSourceFile(
  cwd: string,
  filename: string,
  onError: (message: string) => void,
): Promise<Source | null> {
  const file = join(sourcesDir(cwd), filename);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    onError(
      `source list: failed to read ${filename}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    onError(
      `source list: invalid YAML in ${filename}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  const result = SourceSchema.safeParse(parsed);
  if (!result.success) {
    onError(`source list: schema mismatch in ${filename}`);
    return null;
  }
  return result.data;
}

/** Pad/truncate `value` to exactly `width` characters for table rendering. */
function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + " ".repeat(width - value.length);
}

/**
 * Implementation of `source list`.
 *
 * Renders a fixed-width table (id / kind / url / tags). When no sources exist
 * we print a guidance message instead of an empty table so first-time users
 * are nudged toward `source add`.
 */
export async function listSources(
  args: string[],
  options: SourceCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  let parsed: ListArgs;
  try {
    parsed = parseListArgs(args);
  } catch (e) {
    error(`source list: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printListHelp(log);
    return 0;
  }
  // --enabled-only is wired through for forward compatibility; the schema does
  // not yet model an `enabled` field (see issue #13 for filter extensions), so
  // for now we treat the flag as a no-op rather than an error to keep the CLI
  // surface stable.

  const dir = sourcesDir(cwd);
  if (!(await pathExists(dir))) {
    log("source list: no sources directory (run `radar init` first)");
    return 0;
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    error(`source list: failed to read sources/: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const yamlFiles = entries.filter((f) => f.endsWith(".yaml")).sort();
  if (yamlFiles.length === 0) {
    log("source list: no sources defined (use `radar source add ...`)");
    return 0;
  }

  const sources: Source[] = [];
  for (const filename of yamlFiles) {
    const s = await readSourceFile(cwd, filename, error);
    if (s) sources.push(s);
  }

  if (sources.length === 0) {
    // All entries were malformed; errors already printed by readSourceFile.
    return 1;
  }

  if (parsed.verbose) {
    // Verbose mode: emit a per-source block so we can include multi-line
    // fields (keywords / trustLevel / lastFetchedAt) without breaking the
    // 4-column table contract scripts may rely on. State is read lazily per
    // source so a missing state file is rendered as "never" rather than
    // surfacing as an error (state is created on first `watch run`).
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (!s) continue;
      if (i > 0) log("");
      const lastFetchedAt = await readLastFetchedAt(cwd, s.id, error);
      log(`${s.id}`);
      log(`  kind:           ${s.kind}`);
      log(`  url:            ${s.url}`);
      log(`  name:           ${s.name ?? "-"}`);
      log(`  tags:           ${s.tags.length > 0 ? s.tags.join(",") : "-"}`);
      log(
        `  keywords:       ${s.filters.keywords.length > 0 ? s.filters.keywords.join(",") : "(none — items will be filtered out)"}`,
      );
      log(
        `  excludeKeywords: ${s.filters.excludeKeywords.length > 0 ? s.filters.excludeKeywords.join(",") : "-"}`,
      );
      log(`  trustLevel:     ${s.trustLevel}`);
      log(`  lastFetchedAt:  ${lastFetchedAt}`);
    }
    return 0;
  }

  const idWidth = Math.max(2, ...sources.map((s) => s.id.length));
  const kindWidth = Math.max(4, ...sources.map((s) => s.kind.length));
  const urlWidth = Math.max(3, ...sources.map((s) => s.url.length));

  log(`${pad("ID", idWidth)}  ${pad("KIND", kindWidth)}  ${pad("URL", urlWidth)}  TAGS`);
  for (const s of sources) {
    log(
      `${pad(s.id, idWidth)}  ${pad(s.kind, kindWidth)}  ${pad(s.url, urlWidth)}  ${s.tags.join(",")}`,
    );
  }
  return 0;
}

/**
 * Best-effort read of `state/<id>.yaml`'s `lastFetchedAt`.
 *
 * Returns `"never"` when the state file does not exist or carries no
 * `lastFetchedAt` (e.g. bootstrap-only state with no successful fetch yet),
 * and `"unreadable"` for any other I/O or parse failure. Errors are surfaced
 * via `onError` so the user sees them, but we never throw — `source list` is
 * a read-only listing command and one broken state file should not prevent
 * the rest from rendering.
 */
async function readLastFetchedAt(
  cwd: string,
  sourceId: string,
  onError: (message: string) => void,
): Promise<string> {
  try {
    const state = await loadSourceState(stateDir(cwd), sourceId);
    return state.lastFetchedAt ?? "never";
  } catch (e) {
    onError(
      `source list: failed to read state/${sourceId}.yaml: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "unreadable";
  }
}

/**
 * Implementation of `source remove`.
 *
 * Deletes `sources/<id>.yaml` only. Per user-guide.md and issue #12, this
 * intentionally preserves `state/<id>.yaml` and any `items/` history so users
 * never lose recorded research by toggling a source off.
 */
export async function removeSource(
  args: string[],
  options: SourceCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  let parsed: RemoveArgs;
  try {
    parsed = parseRemoveArgs(args);
  } catch (e) {
    error(`source remove: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printRemoveHelp(log);
    return 0;
  }
  if (!parsed.id) {
    error("source remove: missing <id>");
    printRemoveHelp(error);
    return 2;
  }
  if (!isSafeSourceId(parsed.id)) {
    error(`source remove: invalid <id> '${parsed.id}' (must match [A-Za-z0-9][A-Za-z0-9._-]*)`);
    return 2;
  }

  const file = sourceFile(cwd, parsed.id);
  if (!(await pathExists(file))) {
    error(`source remove: '${parsed.id}' not found (sources/${parsed.id}.yaml)`);
    return 1;
  }

  await unlink(file);
  log(`source remove: deleted sources/${parsed.id}.yaml`);
  return 0;
}

/**
 * Truncate a string to at most `max` characters, appending an ellipsis when
 * truncation actually happened. Whitespace is collapsed first so multi-line
 * body excerpts render as a single readable preview line.
 */
function truncatePreview(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}…`;
}

/**
 * Implementation of `source test`.
 *
 * Dry-run preview for a single source: load `sources/<id>.yaml`, fetch + filter
 * via `watchRun({ dryRun: true })`, and print a `fetched / filtered / matched`
 * summary plus up to `--limit` matched items. Disk state is never mutated —
 * neither `items/` nor `state/<id>.yaml` are written (see `watchRun`'s
 * `dryRun` semantics in `src/core/watcher.ts`).
 *
 * Intended use case: while tuning `--keywords` on a brand-new source, run
 * `radar source test <id>` to see which items would have matched before
 * letting `watch run` ingest them for real.
 */
export async function testSource(
  args: string[],
  options: SourceCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  let parsed: TestArgs;
  try {
    parsed = parseTestArgs(args);
  } catch (e) {
    error(`source test: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printTestHelp(log);
    return 0;
  }
  if (!parsed.id) {
    error("source test: missing <id>");
    printTestHelp(error);
    return 2;
  }
  if (!isSafeSourceId(parsed.id)) {
    error(`source test: invalid <id> '${parsed.id}' (must match [A-Za-z0-9][A-Za-z0-9._-]*)`);
    return 2;
  }

  // Check the YAML exists *before* delegating to watchRun. `watchRun` would
  // otherwise warn and silently return an empty result for an unknown
  // sourceId; we want a hard exit-1 with a user-friendly error here because
  // the user typed the id explicitly.
  const file = sourceFile(cwd, parsed.id);
  if (!(await pathExists(file))) {
    error(`source test: '${parsed.id}' not found (sources/${parsed.id}.yaml)`);
    return 1;
  }

  const limit = parsed.limit ?? 10;

  let result: WatchRunResult;
  try {
    result = await watchRun({
      cwd,
      sourceId: parsed.id,
      dryRun: true,
      fetch: options.fetch,
      log,
      warn,
      error,
    });
  } catch (e) {
    error(`source test: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (result.errors.length > 0) {
    // Per-source error was already reported via the `error` sink inside
    // watchRun; surface a non-zero exit so CI / scripts can detect failure.
    return 1;
  }

  const stats = result.stats[parsed.id];
  const matched = result.detected[parsed.id] ?? [];
  const fetched = stats?.fetched ?? 0;
  const filtered = stats?.filtered ?? matched.length;

  log("");
  log(`source test: ${parsed.id}`);
  log(`  fetched: ${fetched} / filtered: ${filtered} / matched: ${matched.length}`);

  if (matched.length === 0) {
    log("  (no matched items)");
    return 0;
  }

  const shown = matched.slice(0, limit);
  log("");
  log(`Showing ${shown.length} of ${matched.length} matched item(s):`);
  for (let i = 0; i < shown.length; i++) {
    const item = shown[i];
    if (!item) continue;
    log("");
    log(`  ${i + 1}. ${item.title}`);
    log(`     url:             ${item.url}`);
    log(
      `     matchedKeywords: ${item.matchedKeywords.length > 0 ? item.matchedKeywords.join(",") : "-"}`,
    );
    if (parsed.showContent) {
      const body =
        item.summary && item.summary.length > 0
          ? item.summary
          : typeof item.raw === "string"
            ? item.raw
            : "";
      log(`     content:         ${body.length > 0 ? truncatePreview(body, 200) : "-"}`);
    }
  }
  if (matched.length > shown.length) {
    log("");
    log(`  … ${matched.length - shown.length} more (raise --limit to see them)`);
  }
  return 0;
}

/**
 * Top-level dispatcher for `radar source <subcommand>`.
 *
 * Sub-commands are kept as named functions (addSource/listSources/removeSource/
 * testSource) so tests can call them directly with injected IO sinks without
 * spawning the full CLI.
 */
export async function runSource(
  args: string[],
  options: SourceCommandOptions = {},
): Promise<number> {
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printSourceHelp(log);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "add":
      return addSource(rest, options);
    case "list":
      return listSources(rest, options);
    case "remove":
      return removeSource(rest, options);
    case "test":
      return testSource(rest, options);
    default:
      error(`source: unknown subcommand '${sub}'`);
      printSourceHelp(error);
      return 2;
  }
}

export const sourceCommand: Command = {
  name: "source",
  summary: "Manage feed sources (add | list | remove | test)",
  run: (args) => runSource(args),
};
