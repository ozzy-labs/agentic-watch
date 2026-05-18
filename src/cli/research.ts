import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * gray-matter defaults to js-yaml, which auto-converts ISO 8601 strings to
 * Date objects per the YAML 1.1 timestamp tag. That breaks
 * `ResearchFrontmatterSchema`, which expects `createdAt` / `updatedAt` to be
 * strings (ADR-0003). Swap in the `yaml` v2 engine (already a dep of this
 * package) which keeps quoted/unquoted ISO 8601 as a plain string.
 */
const matterOptions = {
  engines: {
    yaml: {
      parse: (s: string) => parseYaml(s) as object,
      stringify: (data: object) => stringifyYaml(data),
    },
  },
};

import { getAgentAdapter } from "../agents/index.js";
import { getDefaultAgent, loadRadarConfig, RadarConfigError } from "../core/config.js";
import { loadItems, saveItems } from "../core/items.js";
import type { ResearchTemplate } from "../core/templates.js";
import { loadTemplate } from "../core/templates.js";
import type { AgentId, Item } from "../schemas/index.js";
import { AgentIdSchema, ResearchFrontmatterSchema } from "../schemas/index.js";
import type { Command } from "./index.js";

/** Sinks for the research command's user-facing output. Tests inject capturing sinks. */
export interface ResearchIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface ResearchCommandOptions {
  cwd?: string;
  io?: ResearchIO;
}

interface ResearchArgs {
  itemIds: string[];
  agent?: string;
  template?: string;
  digest?: boolean;
  help?: boolean;
}

function parseArgs(args: string[]): ResearchArgs {
  const out: ResearchArgs = { itemIds: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--digest") {
      out.digest = true;
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
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    if (a !== undefined) {
      out.itemIds.push(a);
    }
  }
  return out;
}

function printHelp(log: (m: string) => void): void {
  log("Usage:");
  log("  radar research <item-id> [--agent <agent-id>] [--template <template-id>]");
  log("  radar research --digest <item-id> <item-id> ... [--agent <agent-id>] [--template <id>]");
  log("");
  log("Arguments:");
  log("  <item-id>             Item id (matches items/<sourceId>/<item-id>.yaml)");
  log("                        Pass 2 or more ids together with --digest to bundle them.");
  log("");
  log("Options:");
  log(
    "  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)",
  );
  log("  --template <id>       Template id under templates/ (default: default; digest: digest)");
  log("  --digest              Bundle multiple items into a single digest report (ADR-0011)");
  log("");
  log("Output:");
  log("  single-item:  research/<YYYYMMDD>_<slug>_v1.md (ADR-0003)");
  log("  digest:       research/<YYYYMMDD>_digest_<slug>_v1.md (ADR-0011)");
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
 * Slug an Item into the `<sourceId>-<short-slug>` form used by the research
 * filename (`research/<YYYYMMDD>_<slug>_v1.md`).
 *
 * Falls back to the item id when the title is empty/unicode-only. We trim to
 * 60 chars so the resulting filename stays inside typical filesystem limits
 * after adding date prefix and version suffix.
 */
function buildSlug(item: Item): string {
  const baseSource = item.sourceId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const titleSlug = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const tail =
    titleSlug ||
    item.id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60);
  return `${baseSource}-${tail}`;
}

/**
 * Pick `YYYYMMDD` from the item's `publishedAt`, falling back to today (UTC)
 * when the source feed did not provide a publish date.
 */
function buildDatePrefix(item: Item, now: Date): string {
  const iso = item.publishedAt ?? now.toISOString();
  return iso.slice(0, 10).replace(/-/g, "");
}

/**
 * Pick `YYYYMMDD` for digest output. Per ADR-0011 §1, digest filenames use the
 * **generation date** (UTC, CLI invocation time) rather than any item's
 * `publishedAt`. Constituent items rarely share a publish date and the digest
 * is a synthesis artifact, so the generation date is the only stable key.
 */
function buildDigestDatePrefix(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Kebab-case helper used by both digest slug derivation and the clamp routine.
 * Mirrors the algorithm pinned in ADR-0011 §2: lowercase, non-alphanumerics
 * collapse to a single hyphen, leading/trailing hyphens are stripped.
 */
function kebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Trim a slug to `max` characters, but never end mid-word: cut at the last
 * hyphen boundary inside the limit so the slug stays readable when truncated
 * (ADR-0011 §2). When no hyphen is present we fall back to a hard cut.
 */
function clampSlug(s: string, max = 60): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastHyphen = cut.lastIndexOf("-");
  return lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut;
}

/**
 * Derive the digest slug from the constituent items' `matchedKeywords`
 * (ADR-0011 §2).
 *
 * Algorithm:
 *   1. Aggregate every item's `matchedKeywords` into a frequency map keyed by
 *      the normalized (lowercased, trimmed) keyword. Empty strings are
 *      ignored so a noisy `[""]` entry cannot dominate the ranking.
 *   2. Sort by frequency descending, ties broken by lexicographic ascending so
 *      the output is deterministic regardless of input item order.
 *   3. Take the top 1-2 entries, kebab-case each, and join with `-`. If no
 *      keywords are present we fall back to the literal `"digest"` so the
 *      ADR-0011 filename pattern (`<date>_digest_<slug>_v<n>.md`) still
 *      produces a recognizable `<date>_digest_digest_v1.md` artifact.
 *   4. Clamp to 60 chars on hyphen boundaries (`clampSlug`).
 *
 * Stable ordering matters because the digest id is content-addressed: the
 * same item set must always yield the same filename so re-runs can detect
 * collisions deterministically.
 */
function deriveDigestSlug(items: Item[]): string {
  const freq = new Map<string, number>();
  for (const item of items) {
    for (const kw of item.matchedKeywords) {
      const normalized = kw.toLowerCase().trim();
      if (normalized === "") continue;
      freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
    }
  }
  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kw]) => kw);
  const top = ranked.slice(0, 2);
  if (top.length === 0) return "digest";
  return clampSlug(top.map(kebabCase).join("-"));
}

/**
 * Locate `items/<sourceId>/<item-id>.yaml` across all source directories,
 * since the CLI only takes `<item-id>` (sourceId is not on the command line).
 *
 * `loadItems` already walks every source subdir, so we delegate to it and
 * then match by id. Returning the full Item (rather than just the path) lets
 * the caller compute slug / date without a second read.
 */
async function findItem(cwd: string, itemId: string): Promise<{ item: Item } | null> {
  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) return null;
  const items = await loadItems(itemsDir);
  const match = items.find((i) => i.id === itemId);
  if (!match) return null;
  return { item: match };
}

/**
 * Locate multiple items at once. We do a single `loadItems` walk and then
 * map the requested ids against the result, preserving the caller's order
 * for the eventual `itemIds` frontmatter array (ADR-0011 keeps no constraint
 * on order, but stable user-supplied order is the least surprising default).
 *
 * Returns `null` for the first missing id so the caller can emit a targeted
 * error rather than walking `items/` repeatedly.
 */
async function findItems(
  cwd: string,
  itemIds: string[],
): Promise<{ items: Item[] } | { missing: string }> {
  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) return { missing: itemIds[0] };
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

/**
 * Implementation of `radar research <item-id>` (single-item) and
 * `radar research --digest <id1> <id2> ...` (multi-item digest, ADR-0011).
 *
 * High-level flow (Phase 1):
 *   1. Parse + validate args (agent defaults to `claude-code`, template to
 *      `default` for single-item or `digest` for `--digest`).
 *   2. Locate `items/<sourceId>/<item-id>.yaml` for each id and parse it.
 *   3. Load `templates/<template-id>.md` (empty body when default is absent).
 *   4. Compute the output path:
 *        - single-item: `research/<YYYYMMDD>_<slug>_v1.md` (ADR-0003)
 *        - digest:      `research/<YYYYMMDD>_digest_<slug>_v1.md` (ADR-0011)
 *      Refuse to overwrite an existing file — re-runs go through `update`.
 *   5. Invoke the registered agent adapter; the agent writes the report.
 *   6. Validate the report's frontmatter against `ResearchFrontmatterSchema`.
 *   7. Transition every included item: `status` → `researched` and persist.
 *
 * Any step from 4 onward that fails surfaces a non-zero exit code with a
 * targeted message so the user can debug without re-reading the source.
 */
export async function runResearch(
  args: string[],
  options: ResearchCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  let parsed: ResearchArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    error(`research: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printHelp(log);
    return 0;
  }
  if (parsed.itemIds.length === 0) {
    error("research: missing <item-id>");
    printHelp(error);
    return 2;
  }
  // Single-item mode: enforce exactly one positional id so the existing
  // behavior of `radar research <id>` is unambiguous. The user must opt into
  // multi-item mode via `--digest`.
  if (!parsed.digest && parsed.itemIds.length > 1) {
    error(
      `research: multiple <item-id> arguments require --digest (got ${parsed.itemIds.length}: ${parsed.itemIds.join(", ")})`,
    );
    return 2;
  }
  // Digest mode: must bundle 2+ items per ADR-0011 §1 (a single-item digest
  // is indistinguishable from a regular research run and would muddy the ID
  // space). Reject early with exit 2 (argument error).
  if (parsed.digest && parsed.itemIds.length < 2) {
    error(
      `research: --digest requires 2 or more <item-id> arguments (got ${parsed.itemIds.length})`,
    );
    return 2;
  }

  // Resolve the agent honoring the priority chain:
  //   explicit --agent > radar.config.yaml defaultResearchAgent > "claude-code"
  // The explicit value is validated against AgentIdSchema first so a bogus
  // --agent never reaches the config / fallback path.
  let explicitAgent: AgentId | undefined;
  if (parsed.agent !== undefined) {
    const agentResult = AgentIdSchema.safeParse(parsed.agent);
    if (!agentResult.success) {
      error(
        `research: invalid --agent '${parsed.agent}' (expected: claude-code | codex-cli | gemini-cli | copilot)`,
      );
      return 2;
    }
    explicitAgent = agentResult.data;
  }
  let agent: AgentId;
  try {
    const config = await loadRadarConfig(cwd);
    agent = await getDefaultAgent("research", { explicit: explicitAgent, configOverride: config });
  } catch (e) {
    if (e instanceof RadarConfigError) {
      error(`research: ${e.message}`);
      return 2;
    }
    throw e;
  }
  // Phase 2 sub-issues B / C / D / E ship all four adapters. AgentIdSchema
  // already rejected invalid `--agent` values upstream, so any value that
  // reaches here is supported.

  // Default template depends on mode: ADR-0011 §6 pins `digest` as the digest
  // templateId so the bundled `templates/digest.md` is picked up automatically
  // when the user doesn't pass `--template`.
  const templateId = parsed.template ?? (parsed.digest ? "digest" : "default");

  // Locate the item(s). Digest mode collects every id up front so a missing id
  // fails before we invoke the agent (cheap fail-fast vs. burning tokens).
  let items: Item[];
  if (parsed.digest) {
    const result = await findItems(cwd, parsed.itemIds);
    if ("missing" in result) {
      error(`research: item '${result.missing}' not found under items/`);
      return 1;
    }
    items = result.items;
    // ADR-0011 §5: a `dismissed` item must not appear in a digest. Validate
    // up-front so the user can either remove the id or re-detect the source
    // before re-running.
    const dismissed = items.filter((i) => i.status === "dismissed");
    if (dismissed.length > 0) {
      error(
        `research: cannot include dismissed items in a digest: ${dismissed.map((i) => i.id).join(", ")}`,
      );
      return 1;
    }
  } else {
    const found = await findItem(cwd, parsed.itemIds[0]);
    if (!found) {
      error(`research: item '${parsed.itemIds[0]}' not found under items/`);
      return 1;
    }
    items = [found.item];
  }

  // Surface any prompt-injection pre-filter hits recorded by the watcher
  // (ADR-0009 M1a / M5a — Adopt). Audit-only: the agent still runs against
  // the original content, but the user gets an explicit warning so they can
  // `radar dismiss` and re-evaluate before committing tokens.
  for (const item of items) {
    if (item.injectionFlags.length > 0) {
      warn(
        `research: item '${item.id}' has ${item.injectionFlags.length} injection flag(s): ${item.injectionFlags.join(", ")} (audit-only; use \`radar dismiss\` to skip)`,
      );
    }
  }

  // Load template.
  const templatesDir = join(cwd, "templates");
  let template: ResearchTemplate;
  try {
    template = await loadTemplate(templateId, templatesDir);
  } catch (e) {
    error(`research: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Compute output path. Refuse to overwrite an existing file — re-runs go
  // through `radar update` per ADR-0003 / ADR-0011 (immutable history).
  const now = new Date();
  let filename: string;
  if (parsed.digest) {
    const datePrefix = buildDigestDatePrefix(now);
    const slug = deriveDigestSlug(items);
    filename = `${datePrefix}_digest_${slug}_v1.md`;
  } else {
    const single = items[0];
    const datePrefix = buildDatePrefix(single, now);
    const slug = buildSlug(single);
    filename = `${datePrefix}_${slug}_v1.md`;
  }
  const outputPath = join(cwd, "research", filename);
  if (await pathExists(outputPath)) {
    error(`research: ${outputPath} already exists (use \`radar update\` to re-research)`);
    return 1;
  }

  const itemDescription = parsed.digest
    ? `${items.length} items (${items.map((i) => i.id).join(", ")})`
    : `item '${items[0].id}'`;
  log(`research: invoking ${agent} adapter for ${itemDescription} -> ${filename}`);

  // Invoke adapter. The multi-item signature lands via #140; the adapter
  // already handles `items.length === 1` byte-equivalently for single-item
  // callers so no branching is needed here.
  const adapter = getAgentAdapter(agent);
  try {
    await adapter.research({
      agent,
      templateId,
      templateBody: template.body,
      items,
      outputPath,
      cwd,
    });
  } catch (e) {
    error(`research: adapter failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Validate the produced file: frontmatter must parse and match schema.
  if (!(await pathExists(outputPath))) {
    error(
      `research: adapter completed but did not write ${outputPath} (agent ignored the output path?)`,
    );
    return 1;
  }
  let body: string;
  try {
    body = await readFile(outputPath, "utf8");
  } catch (e) {
    error(
      `research: failed to read generated report: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  let frontmatter: unknown;
  try {
    frontmatter = matter(body, matterOptions).data;
  } catch (e) {
    error(`research: failed to parse frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const fmResult = ResearchFrontmatterSchema.safeParse(frontmatter);
  if (!fmResult.success) {
    error(`research: frontmatter does not match ResearchFrontmatterSchema:`);
    for (const issue of fmResult.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return 1;
  }
  // Phase 1 contract: review fields must be null. The schema permits null;
  // we additionally enforce that the agent did not jump ahead and stamp them.
  // Phase 5 contract: `supersedes` is null on v1 by definition (no predecessor
  // exists). Defensive reset applies if a misbehaving agent populates it; the
  // `update` command (Sub-issue B / #41) is the only writer that may set it.
  const reviewedDrift = fmResult.data.reviewedAt !== null || fmResult.data.reviewedBy !== null;
  const supersedesDrift = fmResult.data.supersedes !== null;
  if (reviewedDrift || supersedesDrift) {
    if (reviewedDrift) {
      warn(
        "research: agent populated reviewedAt/reviewedBy; resetting to null (Phase 1 contract — review handles this in Phase 2)",
      );
    }
    if (supersedesDrift) {
      warn(
        "research: agent populated supersedes; resetting to null (Phase 5 contract — v1 has no predecessor; `update` writes supersedes)",
      );
    }
    const parsed = matter(body, matterOptions);
    const rewritten = matter.stringify(
      parsed.content,
      {
        ...fmResult.data,
        reviewedAt: null,
        reviewedBy: null,
        supersedes: null,
      },
      matterOptions,
    );
    await writeFile(outputPath, rewritten, "utf8");
  }

  // Transition item status. ADR-0011 §5: every included item transitions
  // `detected` → `researched`; terminal states (`researched` / `reviewed`)
  // are protected and pass through unchanged so a digest that re-includes
  // an already-researched item does not regress its status.
  const updated: Item[] = items.map((item) =>
    item.status === "detected" ? { ...item, status: "researched" } : item,
  );
  try {
    // saveItems writes by sourceId+id, so it will overwrite the existing file
    // in place. We rely on this rather than constructing the path manually.
    await saveItems(join(cwd, "items"), updated);
  } catch (e) {
    error(`research: failed to update item status: ${e instanceof Error ? e.message : String(e)}`);
    error(`  (research file was written: ${outputPath})`);
    return 1;
  }

  log(`research: wrote ${outputPath}`);
  for (const item of updated) {
    if (item.status === "researched") {
      log(`research: items/${item.sourceId}/${item.id}.yaml status -> researched`);
    }
  }
  return 0;
}

export const researchCommand: Command = {
  name: "research",
  summary: "Generate Markdown research reports from items via an AI agent",
  run: (args) => runResearch(args),
};
