import { join } from "node:path";
import { loadItems, saveItems } from "../core/items.js";
import { allowedTransitions, isValidTransition } from "../core/transitions.js";
import { createTranslator, type Translator } from "../i18n/index.js";
import type { Item, ItemStatus } from "../schemas/index.js";
import { LangFlagError, parseLangFlag, resolveWorkspaceLocale } from "./_locale.js";
import type { Command } from "./index.js";

/** Sinks for the dismiss command's user-facing output. Tests inject capturing sinks. */
export interface DismissIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface DismissCommandOptions {
  cwd?: string;
  io?: DismissIO;
}

/**
 * Default hard-cap for `radar dismiss --batch`.
 *
 * Mirrors `RESEARCH_BATCH_DEFAULT_MAX_ITEMS` / `REVIEW_BATCH_DEFAULT_MAX_ITEMS`
 * (ADR-0014 D3a). dismiss is agent-free so cost is not the driver, but pinning
 * the same literal keeps the batch surface symmetric across commands: a user
 * who learned `--max-items 10` from `research --batch` gets the same default
 * here. A runaway `--backfill` that floods `detected` cannot be cleared in a
 * single unbounded pass — the cap forces an explicit `--max-items` bump.
 */
export const DISMISS_BATCH_DEFAULT_MAX_ITEMS = 10;

/**
 * Whitelist of `Item.status` values accepted by `radar dismiss --batch
 * --status <status>` and by the single/multi-id path.
 *
 * Derived from the ADR-0008 / ADR-0018 state machine: an item may transition
 * to `dismissed` only from `detected` or `triaged_unsure`
 * (`isValidTransition(<status>, "dismissed")`). The two `triaged_research` /
 * `triaged_digest` statuses are NOT dismissible — they flow to `researched`
 * (a triage decision already promoted them), so dismissing them would
 * contradict the classifier; the human path for those is `radar triage --redo`
 * back to `detected` first.
 *
 * Constraining `--batch --status` to this same set means a typo in scheduled
 * YAML fails loud with an explicit allow-list message instead of silently
 * matching zero items (mirrors research/review #250).
 */
export const DISMISS_ALLOWED_STATUSES = [
  "detected",
  "triaged_unsure",
] as const satisfies readonly ItemStatus[];
type DismissAllowedStatus = (typeof DISMISS_ALLOWED_STATUSES)[number];

interface DismissArgs {
  itemIds: string[];
  help?: boolean;
  /** Batch mode: dismiss every item matching --status (and --filter-tags). */
  batch?: boolean;
  /** Restrict batch mode to items with this status (default: `detected`). */
  status?: string;
  /** Hard-cap on items processed in batch mode (default: DISMISS_BATCH_DEFAULT_MAX_ITEMS). */
  maxItems?: string;
  /** Comma-separated allow-list matched against each item's `matchedKeywords`. */
  filterTags?: string;
}

function parseArgs(args: string[]): DismissArgs {
  const out: DismissArgs = { itemIds: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--batch") {
      out.batch = true;
      continue;
    }
    if (a === "--status") {
      out.status = args[++i];
      continue;
    }
    if (a === "--max-items") {
      out.maxItems = args[++i];
      continue;
    }
    if (a === "--filter-tags") {
      out.filterTags = args[++i];
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (a !== undefined) {
      out.itemIds.push(a);
    }
  }
  return out;
}

function printHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.dismiss.help", { maxItems: DISMISS_BATCH_DEFAULT_MAX_ITEMS }));
}

/**
 * Locate `items/<sourceId>/<item-id>.yaml` files for the given ids across all
 * source directories. `loadItems` walks every source subdir, so the caller
 * only needs `<item-id>` (sourceId is inferred from the loaded item).
 *
 * Returns the matched items in the requested order, or `{ missing }` for the
 * first id that has no matching file.
 */
async function findItems(
  cwd: string,
  itemIds: string[],
): Promise<{ items: Item[] } | { missing: string }> {
  const itemsDir = join(cwd, "items");
  const all = await loadItems(itemsDir);
  const byId = new Map(all.map((i) => [i.id, i]));
  const matched: Item[] = [];
  for (const id of itemIds) {
    const m = byId.get(id);
    if (!m) return { missing: id };
    matched.push(m);
  }
  return { items: matched };
}

function parseMaxItems(
  raw: string | undefined,
  error: (m: string) => void,
  t: Translator,
): number | null {
  if (raw === undefined) return DISMISS_BATCH_DEFAULT_MAX_ITEMS;
  if (!/^[0-9]+$/.test(raw)) {
    error(t("cli.dismiss.invalidMaxItemsInteger", { raw }));
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    error(t("cli.dismiss.invalidMaxItemsPositive", { raw }));
    return null;
  }
  return n;
}

function parseFilterTags(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  ];
}

/**
 * Transition a resolved set of items to `dismissed` and persist them.
 *
 * Each item is re-checked against `isValidTransition(status, "dismissed")` —
 * the ADR-0008 / ADR-0018 state machine SSoT — so a stale id (e.g. an item that
 * moved past `detected` between discovery and write) is rejected with a
 * user-friendly message rather than corrupted. The whole batch is validated
 * before any write, so a single offending id fails the call without leaving a
 * partial mutation behind.
 */
async function dismissItems(
  cwd: string,
  items: Item[],
  log: (m: string) => void,
  error: (m: string) => void,
  t: Translator,
): Promise<number> {
  const offenders = items.filter((i) => !isValidTransition(i.status, "dismissed"));
  if (offenders.length > 0) {
    for (const item of offenders) {
      error(
        t("cli.dismiss.itemWrongStatus", {
          id: item.id,
          status: item.status,
          allowed: DISMISS_ALLOWED_STATUSES.join(" | "),
          nextStatuses: allowedTransitions(item.status).join(", ") || "(none)",
        }),
      );
    }
    return 1;
  }

  const updated: Item[] = items.map((item) => ({ ...item, status: "dismissed" as ItemStatus }));
  try {
    await saveItems(join(cwd, "items"), updated);
  } catch (e) {
    error(t("cli.dismiss.failedUpdate", { reason: e instanceof Error ? e.message : String(e) }));
    return 1;
  }

  for (const item of updated) {
    log(t("cli.dismiss.transitioned", { sourceId: item.sourceId, id: item.id }));
  }
  return 0;
}

/**
 * Implementation of `radar dismiss --batch` (#259).
 *
 * Mirrors `research --batch` shape:
 *   1. Validate `--status` against `DISMISS_ALLOWED_STATUSES`.
 *   2. Load items, keep those whose status matches.
 *   3. Apply `--filter-tags` allow-list (case-insensitive) against
 *      `matchedKeywords`.
 *   4. Cap at `--max-items` (drops excess + warns).
 *   5. Transition the selected items to `dismissed` in one write.
 *
 * Designed to absorb the large `detected` backlog produced by
 * `radar watch run --backfill` without the user shelling out a per-id loop.
 */
async function runDismissBatch(
  parsed: DismissArgs,
  cwd: string,
  log: (m: string) => void,
  warn: (m: string) => void,
  error: (m: string) => void,
  t: Translator,
): Promise<number> {
  if (parsed.itemIds.length > 0) {
    error(t("cli.dismiss.batchIncompatiblePositional", { count: parsed.itemIds.length }));
    return 2;
  }

  const rawStatus = parsed.status ?? "detected";
  if (!(DISMISS_ALLOWED_STATUSES as readonly string[]).includes(rawStatus)) {
    error(
      t("cli.dismiss.invalidStatus", {
        status: rawStatus,
        allowed: DISMISS_ALLOWED_STATUSES.join(" | "),
      }),
    );
    return 2;
  }
  const status: DismissAllowedStatus = rawStatus as DismissAllowedStatus;

  const maxItems = parseMaxItems(parsed.maxItems, error, t);
  if (maxItems === null) return 2;
  const filterTags = parseFilterTags(parsed.filterTags);

  const itemsDir = join(cwd, "items");
  const all = await loadItems(itemsDir);
  const matches = all
    .filter((it) => it.status === status)
    .filter((it) => {
      if (filterTags.length === 0) return true;
      const haystack = new Set(it.matchedKeywords.map((k) => k.toLowerCase()));
      return filterTags.some((t) => haystack.has(t));
    })
    .sort((a, b) => {
      const ap = a.publishedAt ?? a.fetchedAt;
      const bp = b.publishedAt ?? b.fetchedAt;
      if (ap !== bp) return ap < bp ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

  const tagsSuffix = filterTags.length > 0 ? `, tags=${filterTags.join(",")}` : "";

  if (matches.length === 0) {
    log(t("cli.dismiss.noItemsMatched", { status, tags: tagsSuffix }));
    return 0;
  }

  let selected = matches;
  if (matches.length > maxItems) {
    const dropped = matches.length - maxItems;
    warn(t("cli.dismiss.capReached", { maxItems, dropped, matched: matches.length }));
    selected = matches.slice(0, maxItems);
  }

  log(
    t("cli.dismiss.batchWillProcess", {
      count: selected.length,
      status,
      tags: tagsSuffix,
      cap: maxItems,
    }),
  );

  const code = await dismissItems(cwd, selected, log, error, t);
  if (code !== 0) return code;
  log(t("cli.dismiss.batchCompleted", { count: selected.length }));
  return 0;
}

/**
 * Implementation of `radar dismiss <item-id> [<item-id> ...]` and
 * `radar dismiss --batch` (#259).
 *
 * Triggers the `detected | triaged_unsure → dismissed` state transition
 * (ADR-0008 / ADR-0018). The command is intentionally agent-free: it only
 * mutates `items/<sourceId>/<item-id>.yaml` so users can prune noise from
 * `watch run` output (including a `--backfill` backlog) without spending agent
 * tokens.
 *
 * Flow:
 *   1. Parse + validate args.
 *   2. `--batch`: discover items by `--status` / `--filter-tags`.
 *      Otherwise: resolve the positional `<item-id>` arguments.
 *   3. Reject any item not in a dismissible status (state-machine guard).
 *   4. Write back with `status: dismissed`.
 */
export async function runDismiss(
  args: string[],
  options: DismissCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  // Strip `--lang <en|ja>` before the command's own parser sees argv (its
  // `parseArgs` rejects unknown `--` flags), then resolve the effective UI
  // locale via --lang > RADAR_LANG > config.locale > default (en) for help text.
  let langState: ReturnType<typeof parseLangFlag>;
  try {
    langState = parseLangFlag(args);
  } catch (e) {
    if (e instanceof LangFlagError) {
      error(`dismiss: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const locale = await resolveWorkspaceLocale({ flag: langState.flag, cwd, warn: error });
  const t = createTranslator(locale);

  let parsed: DismissArgs;
  try {
    parsed = parseArgs(langState.rest);
  } catch (e) {
    error(`dismiss: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printHelp(t, log);
    return 0;
  }
  if (parsed.batch) {
    return runDismissBatch(parsed, cwd, log, warn, error, t);
  }
  // Surface the batch-only flags when used outside `--batch`; matches
  // research/review's "no silent ignore" stance so a typo does not become a
  // no-op.
  if (parsed.status !== undefined) {
    error(t("cli.dismiss.statusRequiresBatch"));
    return 2;
  }
  if (parsed.maxItems !== undefined) {
    error(t("cli.dismiss.maxItemsRequiresBatch"));
    return 2;
  }
  if (parsed.filterTags !== undefined) {
    error(t("cli.dismiss.filterTagsRequiresBatch"));
    return 2;
  }
  if (parsed.itemIds.length === 0) {
    error(t("cli.dismiss.missingItemId"));
    printHelp(t, error);
    return 2;
  }

  // De-dupe positional ids so `radar dismiss a a` does not double-process.
  const uniqueIds = [...new Set(parsed.itemIds)];
  const found = await findItems(cwd, uniqueIds);
  if ("missing" in found) {
    error(t("cli.dismiss.itemNotFound", { id: found.missing }));
    return 1;
  }
  return dismissItems(cwd, found.items, log, error, t);
}

export const dismissCommand: Command = {
  name: "dismiss",
  summary: "Mark detected items as dismissed (single id, multiple ids, or --batch)",
  summaryKey: "cli.summary.dismiss",
  run: (args) => runDismiss(args),
};
