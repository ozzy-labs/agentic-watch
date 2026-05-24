import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { renderReviewPayloadBlock } from "../agents/_boundary.js";
import { getAgentAdapter } from "../agents/index.js";
import { getDefaultAgent, loadRadarConfig, RadarConfigError } from "../core/config.js";
import { loadItems, saveItems } from "../core/items.js";
import type { Locale } from "../core/locale.js";
import type { ProgressReporter } from "../core/progress.js";
import type { ResearchTemplate } from "../core/templates.js";
import { loadTemplate } from "../core/templates.js";
import { isValidTransition } from "../core/transitions.js";
import { createTranslator, type Translator } from "../i18n/index.js";
import type { AgentId, Item, ItemStatus } from "../schemas/index.js";
import { AgentIdSchema, ResearchFrontmatterSchema } from "../schemas/index.js";
import { resolveCommitPathInside } from "./_commit-path.js";
import { LangFlagError, resolveCommandLocale } from "./_locale.js";
import {
  buildAgentProgressCallback,
  buildReporter,
  ProgressFlagError,
  parseProgressFlags,
  pollOutputFileSize,
} from "./_progress.js";
import type { Command } from "./index.js";

/**
 * gray-matter defaults to js-yaml which auto-converts ISO 8601 strings to
 * `Date` objects. That breaks `ResearchFrontmatterSchema`, which expects
 * timestamps as strings. Swap in the `yaml` v2 engine for parity with the
 * `research` command (see src/cli/research.ts for the same rationale).
 */
const matterOptions = {
  engines: {
    yaml: {
      parse: (s: string) => parseYaml(s) as object,
      stringify: (data: object) => stringifyYaml(data),
    },
  },
};

/** Sinks for the review command's user-facing output. Tests inject capturing sinks. */
export interface ReviewIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface ReviewCommandOptions {
  cwd?: string;
  io?: ReviewIO;
  /**
   * Test-only override for the {@link ProgressReporter}. When omitted, the
   * CLI constructs one from `--verbose` / `--quiet` / `RADAR_NO_PROGRESS`
   * (ADR-0015 D2).
   */
  progress?: ProgressReporter;
}

interface ReviewArgs {
  researchId?: string;
  agent?: string;
  template?: string;
  help?: boolean;
  /**
   * Batch mode (#250): review every research file whose linked items are in
   * `--status <status>` (must be `researched`). Mirrors the
   * `research --batch` surface so scheduled YAML can run
   * `radar review --batch --status researched` end-to-end (PR #249).
   */
  batch?: boolean;
  status?: string;
  maxItems?: string;
  filterTags?: string;
  /**
   * Host-agent mode (#254 / ADR-0019): emit the review payload to stdout
   * without spawning an agent. The host (interactive) session runs the SKILL
   * procedure itself (reviews the research file in place), then finalizes via
   * `--commit`.
   */
  emitPayload?: boolean;
  /**
   * Host-agent mode (#254 / ADR-0019): finalize an externally-reviewed report.
   * Holds the path to the research file the host session stamped. The CLI
   * validates it against `ResearchFrontmatterSchema`, asserts the host stamped
   * `reviewedAt` / `reviewedBy`, and applies the `researched → reviewed`
   * transition for the linked items.
   */
  commit?: string;
}

function parseArgs(args: string[]): ReviewArgs {
  const out: ReviewArgs = {};
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
    if (a === "--agent") {
      out.agent = args[++i];
      continue;
    }
    if (a === "--template") {
      out.template = args[++i];
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
    if (a === "--emit-payload") {
      out.emitPayload = true;
      continue;
    }
    if (a === "--commit") {
      out.commit = args[++i];
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (!out.researchId) {
      out.researchId = a;
      continue;
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

/**
 * Default hard-cap for `radar review --batch`.
 *
 * Mirrors `RESEARCH_BATCH_DEFAULT_MAX_ITEMS` (ADR-0014 D3a). Review is the
 * downstream of research, so the same per-tick cost envelope applies; pinning
 * to the same literal keeps a scheduled `research --batch --max-items 10
 * → review --batch` chain from accidentally fanning the review step out
 * faster than research can keep up.
 */
export const REVIEW_BATCH_DEFAULT_MAX_ITEMS = 10;

/**
 * Whitelist of `Item.status` values accepted by `radar review --batch
 * --status <status>`.
 *
 * Only `researched` is valid: review consumes research outputs (ADR-0008
 * `researched → reviewed`) and there is no other prior status that produces
 * a non-null research file with `reviewedAt: null`. We still keep the surface
 * as `--status <status>` (rather than a hardcoded `researched`) so the CLI
 * matches the symmetry of `research --batch --status <status>` and so a typo
 * in scheduled YAML fails loud with an explicit allow-list message instead
 * of being silently ignored (issue #250).
 */
export const REVIEW_BATCH_ALLOWED_STATUSES = ["researched"] as const;
type ReviewBatchStatus = (typeof REVIEW_BATCH_ALLOWED_STATUSES)[number];

function printHelp(t: Translator, log: (m: string) => void): void {
  log(t("cli.review.help", { maxItems: REVIEW_BATCH_DEFAULT_MAX_ITEMS }));
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
 * Resolve `<research-id>` to the actual file on disk.
 *
 * The CLI accepts both `<id>` and `<id>.md` for ergonomics. We validate the
 * resulting path stays inside `research/` so a malicious id like
 * `../etc/passwd` cannot escape the workspace.
 */
function resolveResearchPath(cwd: string, researchId: string): string {
  const id = researchId.endsWith(".md") ? researchId.slice(0, -3) : researchId;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid <research-id>: '${researchId}'`);
  }
  return join(cwd, "research", `${id}.md`);
}

/**
 * Locate the items/<sourceId>/<itemId>.yaml files for a research file's
 * `itemIds`. The research frontmatter records `itemIds` (zero or more) so we
 * need to walk the items dir to find each one — items are stored under the
 * source dir, and the CLI does not carry sourceId in the research frontmatter
 * (ADR-0003 keeps the schema minimal).
 */
async function findItemsForResearch(cwd: string, itemIds: string[]): Promise<Item[]> {
  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) return [];
  const allItems = await loadItems(itemsDir);
  const out: Item[] = [];
  for (const id of itemIds) {
    const match = allItems.find((i) => i.id === id);
    if (match) out.push(match);
  }
  return out;
}

/**
 * Snapshot of files we restore on partial failure.
 *
 * We only snapshot the research file body and the linked item YAML payloads.
 * Both are small enough to keep in memory; persisting backups to disk would
 * just trade one partial-failure window for another (crash between writing
 * backup and writing the real file).
 */
interface AtomicSnapshot {
  researchPath: string;
  researchBody: string;
  itemsDir: string;
  items: Item[];
}

/**
 * Restore the snapshot. Best-effort — if a restore step itself fails, we
 * surface the error to the caller so they can warn the user that manual
 * recovery is required, but we still attempt the remaining restores.
 */
async function restoreSnapshot(snapshot: AtomicSnapshot): Promise<Error[]> {
  const errors: Error[] = [];
  try {
    await writeFile(snapshot.researchPath, snapshot.researchBody, "utf8");
  } catch (e) {
    errors.push(e instanceof Error ? e : new Error(String(e)));
  }
  try {
    await saveItems(snapshot.itemsDir, snapshot.items);
  } catch (e) {
    errors.push(e instanceof Error ? e : new Error(String(e)));
  }
  return errors;
}

/**
 * Host-agent commit path (#254 / ADR-0019): finalize a research file the host
 * session reviewed in place (stamped `reviewedAt` / `reviewedBy`, appended a
 * review block). Independent of agent / template resolution — the report is
 * self-describing via its `itemIds` frontmatter, which this reverse-looks-up
 * against `items/`.
 *
 * Unlike `research --commit`, the CLI does not write the report here (the host
 * already did). The CLI's remaining responsibilities are the ones it must keep
 * owning (ADR-0019): schema validation, asserting the host actually stamped the
 * review, and the `researched → reviewed` state-machine transition.
 *
 * The path is constrained to `<cwd>/research/` first (M3b enforced in code) so
 * a host misled by injected content into committing an arbitrary path is
 * rejected at the CLI boundary.
 */
async function runReviewCommit(params: {
  cwd: string;
  commitPath: string;
  log: (m: string) => void;
  error: (m: string) => void;
  progress: ProgressReporter;
  /** Translator for the user-facing progress phase labels (#313). */
  t: Translator;
}): Promise<number> {
  const { cwd, commitPath, log, error, progress, t } = params;
  const guard = await resolveCommitPathInside(cwd, "research", commitPath);
  if ("error" in guard) {
    error(`review: ${guard.error}`);
    return 2;
  }
  const researchPath = guard.resolved;

  if (!(await pathExists(researchPath))) {
    error(t("cli.review.fileNotFound", { path: researchPath }));
    return 1;
  }
  let body: string;
  try {
    body = await readFile(researchPath, "utf8");
  } catch (e) {
    error(`review: failed to read research file: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let frontmatter: unknown;
  try {
    frontmatter = matter(body, matterOptions).data;
  } catch (e) {
    error(`review: failed to parse frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const fmResult = ResearchFrontmatterSchema.safeParse(frontmatter);
  if (!fmResult.success) {
    error(`review: research frontmatter does not match ResearchFrontmatterSchema:`);
    for (const issue of fmResult.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return 1;
  }
  const fm = fmResult.data;
  progress.phase(t("cli.progress.frontmatterValidated"));

  // The host session is responsible for stamping the review (the CLI no longer
  // spawns an agent in this path). If the stamp is missing the host did not run
  // the review procedure, so refuse to transition the items rather than mark
  // them reviewed against an un-reviewed report.
  if (fm.reviewedAt === null || fm.reviewedBy === null) {
    error(
      t("cli.review.commitNotStamped", {
        id: fm.id,
        reviewedAt: String(fm.reviewedAt),
        reviewedBy: String(fm.reviewedBy),
      }),
    );
    return 1;
  }

  // Reverse-lookup the linked items from the report's `itemIds` frontmatter
  // (mirrors research --commit / finalizeResearch). The report is
  // self-describing, so we do not need a positional <research-id>.
  const all = await loadItems(join(cwd, "items"));
  const byId = new Map(all.map((i) => [i.id, i]));
  const targetItems: Item[] = [];
  for (const id of fm.itemIds) {
    const match = byId.get(id);
    if (!match) {
      error(
        `review: --commit report references unknown item id '${id}' (no items/*/${id}.yaml under ${cwd})`,
      );
      return 1;
    }
    targetItems.push(match);
  }

  // Defer the legal-transition decision to `isValidTransition()` (the ADR-0008
  // / ADR-0018 state machine SSoT). Only items currently in `researched`
  // transition to `reviewed`; any other status is passed through unchanged
  // (defense in depth — a host that committed against a stale items set does
  // not corrupt non-researched items).
  const transitions = new Map<string, ItemStatus>();
  const updated: Item[] = targetItems.map((item) => {
    if (isValidTransition(item.status, "reviewed")) {
      transitions.set(item.id, item.status);
      return { ...item, status: "reviewed" as ItemStatus };
    }
    return item;
  });
  try {
    await saveItems(join(cwd, "items"), updated);
  } catch (e) {
    error(`review: failed to update item status: ${e instanceof Error ? e.message : String(e)}`);
    error(`  (research file was reviewed: ${researchPath})`);
    return 1;
  }

  log(t("cli.review.wroteCommit", { path: researchPath }));
  for (const item of updated) {
    const from = transitions.get(item.id);
    if (from !== undefined && item.status === "reviewed") {
      progress.phase(
        t("cli.progress.statusTransition", { from, to: "reviewed" }),
        `items/${item.sourceId}/${item.id}.yaml`,
      );
      log(t("cli.review.transitioned", { sourceId: item.sourceId, id: item.id }));
    }
  }
  return 0;
}

function parseBatchMaxItems(
  raw: string | undefined,
  error: (m: string) => void,
  t: Translator,
): number | null {
  if (raw === undefined) return REVIEW_BATCH_DEFAULT_MAX_ITEMS;
  if (!/^[0-9]+$/.test(raw)) {
    error(t("cli.review.invalidMaxItemsInteger", { raw }));
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    error(t("cli.review.invalidMaxItemsPositive", { raw }));
    return null;
  }
  return n;
}

function parseBatchFilterTags(raw: string | undefined): string[] {
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
 * Discover candidate research files for `--batch` mode (#250).
 *
 * Walk `research/` for `*.md`, parse frontmatter, and keep entries that:
 *   - parse cleanly against `ResearchFrontmatterSchema`
 *   - have `reviewedAt === null` (un-reviewed; idempotent skip otherwise)
 *
 * Sort deterministically by (createdAt, id) so a scheduled batch always
 * processes oldest-first. The per-item status filter (`--status researched`)
 * is applied by the caller after cross-referencing `items/`.
 */
async function discoverBatchCandidates(
  cwd: string,
): Promise<Array<{ id: string; createdAt: string }>> {
  const researchDir = join(cwd, "research");
  if (!(await pathExists(researchDir))) return [];
  let entries: string[];
  try {
    entries = await readdir(researchDir);
  } catch {
    return [];
  }
  const candidates: Array<{ id: string; createdAt: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    // The frontmatter's `id` field is the canonical research id; we trust
    // it over the filename so a rename does not silently change the id
    // the review CLI passes to the agent.
    let body: string;
    try {
      body = await readFile(join(researchDir, entry), "utf8");
    } catch {
      continue;
    }
    let fm: unknown;
    try {
      fm = matter(body, matterOptions).data;
    } catch {
      // Malformed frontmatter: leave it to the per-item review call to
      // surface the schema error (skipping it silently in discovery hides
      // a real corruption from the user).
      continue;
    }
    const result = ResearchFrontmatterSchema.safeParse(fm);
    if (!result.success) continue;
    if (result.data.reviewedAt !== null) continue;
    candidates.push({ id: result.data.id, createdAt: result.data.createdAt });
  }
  candidates.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return candidates;
}

/**
 * Implementation of `radar review --batch` (#250).
 *
 * Mirrors `research --batch` shape:
 *   1. Validate `--status` against `REVIEW_BATCH_ALLOWED_STATUSES`.
 *   2. Walk `research/` to find un-reviewed research files.
 *   3. Cross-reference linked items; keep those whose status matches.
 *   4. Apply `--filter-tags` allow-list (case-insensitive) against linked
 *      items' `matchedKeywords`.
 *   5. Cap at `--max-items` (drops excess + warns).
 *   6. Run the existing single-review path per candidate. Atomicity, agent
 *      resolution, and rollback all reuse `runReview`'s implementation —
 *      this function intentionally stays a thin orchestrator.
 *
 * Workflow YAML generated by `radar workflow generate combined-with-triage`
 * (PR #249) drives this entry point: `radar review --batch --status
 * researched --agent <reviewAgent>`.
 */
async function runReviewBatch(
  parsed: ReviewArgs,
  cwd: string,
  locale: Locale,
  options: ReviewCommandOptions,
  log: (m: string) => void,
  warn: (m: string) => void,
  error: (m: string) => void,
  progress: ProgressReporter,
  t: Translator,
): Promise<number> {
  if (parsed.researchId !== undefined) {
    error(t("cli.review.batchIncompatiblePositional", { researchId: parsed.researchId }));
    return 2;
  }
  const rawStatus = parsed.status ?? "researched";
  if (!(REVIEW_BATCH_ALLOWED_STATUSES as readonly string[]).includes(rawStatus)) {
    error(
      t("cli.review.invalidStatus", {
        status: rawStatus,
        allowed: REVIEW_BATCH_ALLOWED_STATUSES.join(" | "),
      }),
    );
    return 2;
  }
  const status: ReviewBatchStatus = rawStatus as ReviewBatchStatus;

  const maxItems = parseBatchMaxItems(parsed.maxItems, error, t);
  if (maxItems === null) return 2;
  const filterTags = parseBatchFilterTags(parsed.filterTags);

  // Resolve the agent once up front so the batch fails fast on a typo
  // rather than 10x reporting it once per candidate. The per-item review
  // path will re-resolve (defensively), but it will hit the same
  // explicit-agent slot and short-circuit identically.
  let explicitAgent: AgentId | undefined;
  if (parsed.agent !== undefined) {
    const agentResult = AgentIdSchema.safeParse(parsed.agent);
    if (!agentResult.success) {
      error(t("cli.agent.invalid", { cmd: "review", agent: parsed.agent }));
      return 2;
    }
    explicitAgent = agentResult.data;
  }
  let agent: AgentId;
  try {
    const config = await loadRadarConfig(cwd);
    agent = await getDefaultAgent("review", { explicit: explicitAgent, configOverride: config });
  } catch (e) {
    if (e instanceof RadarConfigError) {
      error(`review: ${e.message}`);
      return 2;
    }
    throw e;
  }

  const candidates = await discoverBatchCandidates(cwd);
  if (candidates.length === 0) {
    log(t("cli.review.batchFoundNone"));
    return 0;
  }

  // Cross-reference linked items so we can apply the per-item `--status`
  // and `--filter-tags` filters. Loading items once and reusing the
  // Map<id, Item> across candidates avoids quadratic scans for workspaces
  // with many sources / items.
  const itemsDir = join(cwd, "items");
  const allItems = await loadItems(itemsDir);
  const itemsById = new Map<string, Item>(allItems.map((i) => [i.id, i]));

  const lowerFilterTags = filterTags;
  type Matched = { researchId: string; createdAt: string; itemIds: string[] };
  const matches: Matched[] = [];
  for (const cand of candidates) {
    // Re-read frontmatter to discover the linked itemIds — discovery only
    // captured the bare `id` / `createdAt` to keep memory bounded.
    const researchPath = join(cwd, "research", `${cand.id}.md`);
    let body: string;
    try {
      body = await readFile(researchPath, "utf8");
    } catch {
      continue;
    }
    const fm = ResearchFrontmatterSchema.safeParse(matter(body, matterOptions).data);
    if (!fm.success) continue;
    const linked = fm.data.itemIds.map((id) => itemsById.get(id)).filter((i): i is Item => !!i);
    if (linked.length === 0) continue;
    // Every linked item must satisfy --status; mixed states would leave the
    // review pass with a partially-eligible candidate that the downstream
    // review code rejects anyway. Failing fast here keeps the per-item
    // error budget cheap.
    if (!linked.every((i) => i.status === status)) continue;
    if (lowerFilterTags.length > 0) {
      const tagged = linked.some((i) => {
        const haystack = new Set(i.matchedKeywords.map((k) => k.toLowerCase()));
        return lowerFilterTags.some((t) => haystack.has(t));
      });
      if (!tagged) continue;
    }
    matches.push({ researchId: cand.id, createdAt: cand.createdAt, itemIds: fm.data.itemIds });
  }

  const tagsSuffix = filterTags.length > 0 ? `, tags=${filterTags.join(",")}` : "";
  if (matches.length === 0) {
    log(t("cli.review.batchMatchedZero", { status, tags: tagsSuffix }));
    return 0;
  }

  let selected = matches;
  if (matches.length > maxItems) {
    const dropped = matches.length - maxItems;
    warn(t("cli.review.capReached", { maxItems, dropped, matched: matches.length }));
    selected = matches.slice(0, maxItems);
  }

  log(
    t("cli.review.batchWillProcess", {
      count: selected.length,
      status,
      tags: tagsSuffix,
      agent,
      cap: maxItems,
    }),
  );

  // Dispatch each candidate through the single-review path. We pass the
  // resolved agent explicitly so each call short-circuits the config
  // resolver to the same value the batch already accepted.
  const innerOptions: ReviewCommandOptions = {
    cwd,
    io: { log, warn, error },
    progress: options.progress ?? progress,
  };
  for (const m of selected) {
    // Forward the already-resolved locale (#316) as an explicit `--lang` so an
    // outer `--lang` (which this batch consumed) keeps its top priority in the
    // per-candidate child invocation rather than silently falling back to
    // RADAR_LANG / config.locale.
    const innerArgs = [m.researchId, "--agent", agent, "--lang", locale];
    if (parsed.template !== undefined) {
      innerArgs.push("--template", parsed.template);
    }
    const code = await runReview(innerArgs, innerOptions);
    if (code !== 0) {
      error(t("cli.review.batchHalted", { researchId: m.researchId, exitCode: code }));
      return code;
    }
  }
  log(t("cli.review.batchCompleted", { count: selected.length }));
  return 0;
}

/**
 * Implementation of `radar review <research-id>`.
 *
 * High-level flow (Phase 2):
 *   1. Parse + validate args (agent defaults to `claude-code`, template to `default`).
 *   2. Resolve `research/<research-id>.md` and parse its frontmatter.
 *   3. Refuse to re-review (frontmatter already has `reviewedAt`).
 *   4. Locate the linked items and verify their status is `researched`.
 *   5. Load `templates/<template-id>.md` (empty body when default is absent).
 *   6. Snapshot the research file body and item payloads (rollback target).
 *   7. Invoke the adapter; the agent rewrites the research file in place
 *      (appends review block + stamps `reviewedAt` / `reviewedBy`).
 *   8. Re-read the research file, validate the updated frontmatter.
 *   9. Transition each linked item: `status` → `reviewed` and persist.
 *      If this step fails, restore the snapshot from (6) and exit non-zero.
 *
 * The snapshot/restore strategy gives us atomicity at the workspace level
 * (ADR-0003 / ADR-0008): either both the research file and the linked items
 * reflect the new review, or neither does.
 */
export async function runReview(
  args: string[],
  options: ReviewCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  // See `src/cli/research.ts` for the rationale of the two-stage parse:
  // we strip `--verbose` / `--quiet` first so the command-local parser only
  // sees the review-specific argv.
  let progressState: ReturnType<typeof parseProgressFlags>;
  try {
    progressState = parseProgressFlags(args);
  } catch (e) {
    if (e instanceof ProgressFlagError) {
      error(`review: ${e.message}`);
      return 2;
    }
    throw e;
  }
  // Resolve the report-output locale (#316) BEFORE the command parser sees argv
  // (strips `--lang`). `config.locale` is the lowest-priority source, read
  // best-effort here; a malformed config is reported authoritatively by the
  // agent resolver below, so we tolerate the error as "no config locale".
  // Resolved before the reporter so progress (#313) and report output (#316)
  // share the same locale.
  let configLocale: string | undefined;
  try {
    configLocale = (await loadRadarConfig(cwd)).locale;
  } catch {
    configLocale = undefined;
  }
  let langRest: string[];
  let locale: Locale;
  try {
    const resolved = resolveCommandLocale(progressState.rest, configLocale, { warn });
    langRest = resolved.rest;
    locale = resolved.locale;
  } catch (e) {
    if (e instanceof LangFlagError) {
      error(`review: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const progress = options.progress ?? buildReporter({ level: progressState.level, locale });
  // Translator for the user-facing progress phase labels (#313). Built from the
  // same resolved locale used for the report-output language (#316) so the
  // spinner / phase markers track the report body language. Built independently
  // of `progress` so a test-injected reporter still gets localized labels.
  const t = createTranslator(locale);

  let parsed: ReviewArgs;
  try {
    parsed = parseArgs(langRest);
  } catch (e) {
    error(`review: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printHelp(t, log);
    return 0;
  }
  // Host-agent commit (#254 / ADR-0019). Independent of agent / template
  // resolution: the report is self-describing via its `itemIds` frontmatter.
  // Handled before the other modes since it takes a path, not a <research-id>.
  if (parsed.commit !== undefined) {
    if (parsed.batch) {
      error(t("cli.review.commitIncompatibleBatch"));
      return 2;
    }
    if (parsed.emitPayload) {
      error(t("cli.review.commitIncompatibleEmitPayload"));
      return 2;
    }
    if (parsed.researchId !== undefined) {
      error(t("cli.review.commitTakesPath", { researchId: parsed.researchId }));
      return 2;
    }
    return runReviewCommit({ cwd, commitPath: parsed.commit, log, error, progress, t });
  }
  if (parsed.emitPayload && parsed.batch) {
    error(t("cli.review.emitPayloadIncompatibleBatch"));
    return 2;
  }
  if (parsed.batch) {
    return runReviewBatch(parsed, cwd, locale, options, log, warn, error, progress, t);
  }
  // Surface the batch-only flags when used outside `--batch`; matches
  // `research.ts`'s "no silent ignore" stance so a typo in scheduled YAML
  // does not become a no-op.
  if (parsed.status !== undefined) {
    error(t("cli.review.statusRequiresBatch"));
    return 2;
  }
  if (parsed.maxItems !== undefined) {
    error(t("cli.review.maxItemsRequiresBatch"));
    return 2;
  }
  if (parsed.filterTags !== undefined) {
    error(t("cli.review.filterTagsRequiresBatch"));
    return 2;
  }
  if (!parsed.researchId) {
    error(t("cli.review.missingResearchId"));
    printHelp(t, error);
    return 2;
  }

  // Resolve the agent honoring the priority chain:
  //   explicit --agent > radar.config.yaml defaultReviewAgent > "claude-code"
  // The explicit value is validated against AgentIdSchema first so a bogus
  // --agent never reaches the config / fallback path. Mirrors runResearch's
  // resolver so #29 (review) and #30 (radar.config) stay aligned.
  let explicitAgent: AgentId | undefined;
  if (parsed.agent !== undefined) {
    const agentResult = AgentIdSchema.safeParse(parsed.agent);
    if (!agentResult.success) {
      error(t("cli.agent.invalid", { cmd: "review", agent: parsed.agent }));
      return 2;
    }
    explicitAgent = agentResult.data;
  }
  let agent: AgentId;
  try {
    const config = await loadRadarConfig(cwd);
    agent = await getDefaultAgent("review", { explicit: explicitAgent, configOverride: config });
  } catch (e) {
    if (e instanceof RadarConfigError) {
      error(`review: ${e.message}`);
      return 2;
    }
    throw e;
  }
  // Phase 2 sub-issues B / C / D / E ship all four adapters. AgentIdSchema
  // already rejected invalid `--agent` values upstream, so any value that
  // reaches here is supported.

  const templateId = parsed.template ?? "default";

  // Resolve research path.
  let researchPath: string;
  try {
    researchPath = resolveResearchPath(cwd, parsed.researchId);
  } catch (e) {
    error(`review: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (!(await pathExists(researchPath))) {
    error(t("cli.review.fileNotFound", { path: researchPath }));
    return 1;
  }

  // Parse research frontmatter (pre-review state).
  let researchBody: string;
  try {
    researchBody = await readFile(researchPath, "utf8");
  } catch (e) {
    error(`review: failed to read research file: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let preFrontmatter: unknown;
  try {
    preFrontmatter = matter(researchBody, matterOptions).data;
  } catch (e) {
    error(`review: failed to parse frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const preResult = ResearchFrontmatterSchema.safeParse(preFrontmatter);
  if (!preResult.success) {
    error(`review: research frontmatter does not match ResearchFrontmatterSchema:`);
    for (const issue of preResult.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return 1;
  }
  const preFm = preResult.data;

  // Refuse re-review. ADR-0008 leaves "re-review after update" undefined and
  // we explicitly block the idempotent case here so users do not silently
  // overwrite an existing review stamp.
  if (preFm.reviewedAt !== null || preFm.reviewedBy !== null) {
    error(
      t("cli.review.alreadyReviewed", {
        id: preFm.id,
        reviewedAt: String(preFm.reviewedAt),
        reviewedBy: String(preFm.reviewedBy),
      }),
    );
    return 1;
  }

  // Resolve linked items.
  const linkedItems = await findItemsForResearch(cwd, preFm.itemIds);
  if (linkedItems.length === 0) {
    error(
      `review: no items/<id>.yaml found for itemIds=[${preFm.itemIds.join(", ")}] referenced by ${preFm.id}`,
    );
    return 1;
  }
  if (linkedItems.length !== preFm.itemIds.length) {
    const found = new Set(linkedItems.map((i) => i.id));
    const missing = preFm.itemIds.filter((id) => !found.has(id));
    error(
      `review: ${missing.length} linked item(s) not found: ${missing.join(", ")} (referenced by ${preFm.id})`,
    );
    return 1;
  }
  const unresearched = linkedItems.filter((i) => i.status !== "researched");
  if (unresearched.length > 0) {
    error(
      `review: linked items must be in status 'researched' before review. Offenders: ${unresearched
        .map((i) => `${i.id}=${i.status}`)
        .join(", ")}`,
    );
    return 1;
  }

  // Surface any prompt-injection pre-filter hits recorded by the watcher
  // (ADR-0009 M1a / M5a — Adopt). Audit-only: review still proceeds against
  // the original research file, but the user sees the audit trail before
  // tokens are spent on the cross-agent review pass.
  for (const linked of linkedItems) {
    if (linked.injectionFlags.length > 0) {
      warn(
        `review: item '${linked.id}' has ${linked.injectionFlags.length} injection flag(s): ${linked.injectionFlags.join(", ")} (audit-only; the linked research was generated from possibly tainted content)`,
      );
    }
  }

  // Phase marker: linked items resolved. Review operates on a single
  // research file but multiple items may back it (digest); list them all so
  // the user can see what's about to be re-touched.
  progress.phase(
    linkedItems.length === 1
      ? t("cli.progress.loadedItem", { id: linkedItems[0].id })
      : t("cli.progress.loadedItems", { count: linkedItems.length }),
    linkedItems.map((i) => i.id).join(", "),
  );

  // Load template.
  const templatesDir = join(cwd, "templates");
  let template: ResearchTemplate;
  try {
    template = await loadTemplate(templateId, templatesDir);
  } catch (e) {
    error(`review: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  progress.phase(t("cli.progress.loadedTemplate", { templateId }));

  // Host-agent emit (#254 / ADR-0019): same research / item / template
  // resolution and pre-review guards as the spawn path (reviewedAt===null,
  // linked items researched), but print the payload instead of spawning. No
  // snapshot / rollback is needed because nothing is written here — the host
  // session does the in-place edit and finalizes via `radar review --commit`.
  if (parsed.emitPayload) {
    log(
      renderReviewPayloadBlock({
        agent,
        templateId,
        templateBody: template.body,
        researchPath,
        researchFrontmatter: preFm,
        researchBody,
      }),
    );
    return 0;
  }

  // Snapshot for atomic rollback.
  const itemsDir = join(cwd, "items");
  const snapshot: AtomicSnapshot = {
    researchPath,
    researchBody,
    itemsDir,
    items: linkedItems.map((i) => ({ ...i })),
  };

  log(`review: invoking ${agent} adapter for research '${preFm.id}'`);

  // Phase marker + spinner for the agent run. See `research.ts` for the
  // rationale of pairing `phase("Spawning …")` with `start("Agent running")`.
  progress.phase(t("cli.progress.spawning", { agent }), `cwd: ${cwd}`);
  progress.start(t("cli.progress.agentRunning"));
  const adapterStartedAt = Date.now();
  const polling = pollOutputFileSize({ path: researchPath, reporter: progress });

  // Invoke adapter.
  const adapter = getAgentAdapter(agent);
  try {
    await adapter.review({
      agent,
      templateId,
      templateBody: template.body,
      researchPath,
      researchFrontmatter: preFm,
      researchBody,
      cwd,
      locale,
      onProgress: buildAgentProgressCallback(progress),
    });
  } catch (e) {
    polling.stop();
    progress.fail(t("cli.progress.agentFailed"), e instanceof Error ? e.message : String(e));
    error(`review: adapter failed: ${e instanceof Error ? e.message : String(e)}`);
    // The agent may have partially written to researchPath before failing.
    // Restore the snapshot so the workspace stays consistent.
    const restoreErrors = await restoreSnapshot(snapshot);
    if (restoreErrors.length > 0) {
      for (const re of restoreErrors) {
        error(`review: rollback partially failed: ${re.message}`);
      }
      error(
        `review: workspace may be in an inconsistent state — inspect ${researchPath} and items/`,
      );
    } else {
      warn("review: rolled back research file and item status to pre-review state");
    }
    return 1;
  }

  // Adapter returned 0 — stop the spinner and surface the duration. The
  // file-size poll is stopped in both the success and error branches so the
  // unref'd timer never lingers into the next CLI invocation under test.
  polling.stop();
  progress.succeed(
    t("cli.progress.agentCompleted", { exitCode: 0 }),
    Date.now() - adapterStartedAt,
  );

  // Re-read and validate the modified research file.
  let postBody: string;
  try {
    postBody = await readFile(researchPath, "utf8");
  } catch (e) {
    error(
      `review: failed to read research file after adapter: ${e instanceof Error ? e.message : String(e)}`,
    );
    await restoreSnapshot(snapshot);
    return 1;
  }
  let postFrontmatter: unknown;
  try {
    postFrontmatter = matter(postBody, matterOptions).data;
  } catch (e) {
    error(
      `review: failed to parse frontmatter after adapter: ${e instanceof Error ? e.message : String(e)}`,
    );
    await restoreSnapshot(snapshot);
    return 1;
  }
  const postResult = ResearchFrontmatterSchema.safeParse(postFrontmatter);
  if (!postResult.success) {
    error(`review: post-adapter frontmatter does not match ResearchFrontmatterSchema:`);
    for (const issue of postResult.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    await restoreSnapshot(snapshot);
    return 1;
  }
  const postFm = postResult.data;
  if (postFm.reviewedAt === null) {
    error("review: adapter completed but did not stamp `reviewedAt` in frontmatter");
    await restoreSnapshot(snapshot);
    return 1;
  }
  if (postFm.reviewedBy !== agent) {
    error(`review: adapter stamped reviewedBy='${postFm.reviewedBy}', expected '${agent}'`);
    await restoreSnapshot(snapshot);
    return 1;
  }
  // Other immutable frontmatter fields must remain unchanged. Catching a
  // misbehaving agent that rewrote `id` / `itemIds` / `agent` / `createdAt` /
  // `supersedes` here is cheaper than letting the inconsistency leak
  // downstream. `supersedes` is owned by `research` (v1=null) and `update`
  // (v+1=<prev id>); `review` must never touch it.
  const drift: string[] = [];
  if (postFm.id !== preFm.id) drift.push(`id (${preFm.id} -> ${postFm.id})`);
  if (postFm.agent !== preFm.agent) drift.push(`agent (${preFm.agent} -> ${postFm.agent})`);
  if (postFm.templateId !== preFm.templateId)
    drift.push(`templateId (${preFm.templateId} -> ${postFm.templateId})`);
  if (postFm.createdAt !== preFm.createdAt)
    drift.push(`createdAt (${preFm.createdAt} -> ${postFm.createdAt})`);
  if (JSON.stringify(postFm.itemIds) !== JSON.stringify(preFm.itemIds))
    drift.push(`itemIds (${preFm.itemIds.join(",")} -> ${postFm.itemIds.join(",")})`);
  if (postFm.supersedes !== preFm.supersedes)
    drift.push(`supersedes (${preFm.supersedes} -> ${postFm.supersedes})`);
  if (drift.length > 0) {
    error(`review: adapter mutated immutable frontmatter fields: ${drift.join("; ")}`);
    await restoreSnapshot(snapshot);
    return 1;
  }
  progress.phase(t("cli.progress.frontmatterValidated"));

  // Now transition item status. If this fails (filesystem error, permissions,
  // etc.), restore both the research file and the items snapshot so the
  // workspace stays atomic.
  const updatedItems: Item[] = linkedItems.map((i) => ({ ...i, status: "reviewed" }));
  try {
    await saveItems(itemsDir, updatedItems);
  } catch (e) {
    error(`review: failed to update item status: ${e instanceof Error ? e.message : String(e)}`);
    const restoreErrors = await restoreSnapshot(snapshot);
    if (restoreErrors.length > 0) {
      for (const re of restoreErrors) {
        error(`review: rollback partially failed: ${re.message}`);
      }
      error(
        `review: workspace may be in an inconsistent state — inspect ${researchPath} and items/`,
      );
    } else {
      warn("review: rolled back research file (item status update failed)");
    }
    return 1;
  }

  log(
    t("cli.review.stamped", {
      path: researchPath,
      reviewedAt: String(postFm.reviewedAt),
      reviewedBy: agent,
    }),
  );
  for (const item of updatedItems) {
    // Phase marker per item so the digest case (multiple itemIds) is still
    // explicit about which yaml files moved. Uses the same `Status: a → b`
    // shape as `research.ts` per ADR-0015 D4.
    progress.phase(
      t("cli.progress.statusTransition", { from: "researched", to: "reviewed" }),
      `items/${item.sourceId}/${item.id}.yaml`,
    );
    log(t("cli.review.transitioned", { sourceId: item.sourceId, id: item.id }));
  }
  return 0;
}

export const reviewCommand: Command = {
  name: "review",
  summary: "Cross-review existing research reports using a different AI agent",
  summaryKey: "cli.summary.review",
  run: (args) => runReview(args),
};
