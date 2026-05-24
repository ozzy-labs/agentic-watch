import { access } from "node:fs/promises";
import { join } from "node:path";
import { loadItems } from "../core/items.js";
import { createTranslator, type Translator } from "../i18n/index.js";
import type { Item, ItemStatus } from "../schemas/index.js";
import { ItemStatusSchema } from "../schemas/index.js";
import { LangFlagError, parseLangFlag, resolveWorkspaceLocale } from "./_locale.js";
import type { Command } from "./index.js";

/**
 * `radar items list` (ADR-0018 PR-3).
 *
 * Lists items from `items/` with composable filters. Designed both for
 * humans (default tabular output) and for piping into workflow generators
 * (`--json` / `--field`).
 *
 * Filter semantics:
 *
 * - `--status <status>`: exact match on `Item.status`. Multiple statuses
 *   are not supported; pipe through `grep -E` if needed.
 * - `--source <id>`: matches `Item.sourceId`.
 * - `--triage-group <name>`: matches `Item.triage.group`. Used by the
 *   digest workflow to gather every item in a group.
 * - `--since <duration>`: cutoff in `Nd` / `Nh` form, applied to
 *   `publishedAt ?? fetchedAt`. Items older than the cutoff are dropped.
 * - `--limit N`: caps result count after filtering.
 *
 * Output:
 *
 * - default: fixed-width table (id, status, source, publishedAt,
 *   matched_keywords, triage.decision when present)
 * - `--json`: JSON array (one object per item)
 * - `--field <expr>`: print one item field per row (used for piping)
 */

export interface ItemsIO {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface ItemsCommandOptions {
  cwd?: string;
  io?: ItemsIO;
}

interface ListArgs {
  status?: string;
  source?: string;
  triageGroup?: string;
  since?: string;
  limit?: number;
  json?: boolean;
  field?: string;
  help?: boolean;
}

function parseIntFlag(flag: string, raw: string | undefined, min: number): number {
  if (raw === undefined) throw new Error(`option ${flag} requires a value`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`option ${flag} expects an integer >= ${min}, got '${raw}'`);
  }
  return n;
}

function parseListArgs(args: string[]): ListArgs {
  const out: ListArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--status") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.status = value;
      continue;
    }
    if (a === "--source") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.source = value;
      continue;
    }
    if (a === "--triage-group") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.triageGroup = value;
      continue;
    }
    if (a === "--since") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.since = value;
      continue;
    }
    if (a === "--limit") {
      out.limit = parseIntFlag(a, args[++i], 1);
      continue;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--field") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.field = value;
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

function printListHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.items.listHelp"));
}

function printItemsHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.items.help"));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `Nd` / `Nh` / `Nm` / `Ns` cutoff strings to a `Date` representing
 * the threshold (= now - duration). Returns `null` on unparsable input so
 * the caller can surface a clear error.
 */
function parseSinceCutoff(value: string, now: Date = new Date()): Date | null {
  const match = value.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2];
  const ms =
    unit === "s"
      ? n * 1000
      : unit === "m"
        ? n * 60_000
        : unit === "h"
          ? n * 3_600_000
          : n * 86_400_000;
  return new Date(now.getTime() - ms);
}

/**
 * Resolve a dot-path expression like `triage.decision` against an item.
 * Used by `--field <expr>`. Missing intermediate fields return `undefined`
 * (silently — the caller renders `-` for missing values).
 */
function resolveField(item: Item, expr: string): unknown {
  let current: unknown = item;
  for (const part of expr.split(".")) {
    if (current === undefined || current === null) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + " ".repeat(width - value.length);
}

function renderJsonValue(value: unknown): string {
  if (value === undefined || value === null) return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Top-level dispatcher for `radar items <subcommand>`.
 */
export async function runItems(args: string[], options: ItemsCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  // Resolve the dispatcher help locale from any leading `--lang` (read-only;
  // the full `args` still flow to the `list` subcommand which strips its own).
  const dispatcherLangFlag = ((): string | undefined => {
    try {
      return parseLangFlag(args).flag;
    } catch {
      return undefined;
    }
  })();
  const dispatcherLocale = await resolveWorkspaceLocale({
    flag: dispatcherLangFlag,
    cwd,
    warn: error,
  });
  const t = createTranslator(dispatcherLocale);

  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printItemsHelp(t, log);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "list":
      return runItemsList(rest, options);
    default:
      error(`items: unknown subcommand '${sub}'`);
      printItemsHelp(t, error);
      return 2;
  }
}

/**
 * Implementation of `radar items list`.
 */
export async function runItemsList(
  args: string[],
  options: ItemsCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  // Strip `--lang <en|ja>` before `parseListArgs` (which rejects unknown
  // flags), then resolve the UI locale for the list help text.
  let langState: ReturnType<typeof parseLangFlag>;
  try {
    langState = parseLangFlag(args);
  } catch (e) {
    if (e instanceof LangFlagError) {
      error(`items list: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const locale = await resolveWorkspaceLocale({ flag: langState.flag, cwd, warn: error });
  const t = createTranslator(locale);

  let parsed: ListArgs;
  try {
    parsed = parseListArgs(langState.rest);
  } catch (e) {
    error(`items list: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printListHelp(t, log);
    return 0;
  }

  // Validate --status against the schema enum early so typos like
  // "triaged_reasearch" fail fast with a list of valid values.
  let statusFilter: ItemStatus | undefined;
  if (parsed.status !== undefined) {
    const v = ItemStatusSchema.safeParse(parsed.status);
    if (!v.success) {
      error(
        `items list: invalid --status '${parsed.status}' (expected: ${ItemStatusSchema.options.join(" | ")})`,
      );
      return 2;
    }
    statusFilter = v.data;
  }

  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) {
    if (parsed.json) {
      log("[]");
      return 0;
    }
    log("items list: no items/ directory (run `radar init` first)");
    return 0;
  }

  let items: Item[];
  try {
    items = await loadItems(itemsDir, parsed.source);
  } catch (e) {
    error(`items list: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Apply filters in cheap-first order.
  if (statusFilter) {
    items = items.filter((i) => i.status === statusFilter);
  }
  if (parsed.triageGroup) {
    items = items.filter((i) => i.triage?.group === parsed.triageGroup);
  }
  if (parsed.since) {
    const cutoff = parseSinceCutoff(parsed.since);
    if (!cutoff) {
      error(`items list: invalid --since '${parsed.since}' (expected Ns | Nm | Nh | Nd)`);
      return 2;
    }
    items = items.filter((i) => {
      const ts = i.publishedAt ?? i.fetchedAt;
      return new Date(ts) >= cutoff;
    });
  }
  // Deterministic order: publishedAt desc (newest first), with fetchedAt as
  // fallback and id as the final tie-breaker. Stable order matters for
  // pipelines that diff the output across runs.
  items.sort((a, b) => {
    const aTs = a.publishedAt ?? a.fetchedAt;
    const bTs = b.publishedAt ?? b.fetchedAt;
    if (aTs !== bTs) return bTs.localeCompare(aTs);
    return a.id.localeCompare(b.id);
  });
  if (parsed.limit !== undefined && items.length > parsed.limit) {
    items = items.slice(0, parsed.limit);
  }

  // Output dispatch.
  if (parsed.field) {
    for (const item of items) {
      const v = resolveField(item, parsed.field);
      log(renderJsonValue(v));
    }
    return 0;
  }
  if (parsed.json) {
    log(JSON.stringify(items, null, 2));
    return 0;
  }

  if (items.length === 0) {
    log("items list: no items match the filter");
    return 0;
  }

  // Default tabular output.
  const headers = ["ID", "STATUS", "SOURCE", "PUBLISHED", "MATCHED", "TRIAGE"];
  const rows = items.map((i) => [
    i.id,
    i.status,
    i.sourceId,
    i.publishedAt ?? i.fetchedAt,
    i.matchedKeywords.join(",") || "-",
    i.triage?.decision ?? "-",
  ]);
  const widths = headers.map((h, idx) =>
    Math.max(h.length, ...rows.map((r) => (r[idx] ?? "").length)),
  );
  log(headers.map((h, idx) => pad(h, widths[idx] ?? 0)).join("  "));
  for (const row of rows) {
    log(row.map((c, idx) => pad(c, widths[idx] ?? 0)).join("  "));
  }
  return 0;
}

export const itemsCommand: Command = {
  name: "items",
  summary: "Inspect items in the workspace (list | ...)",
  summaryKey: "cli.summary.items",
  run: (args) => runItems(args),
};
