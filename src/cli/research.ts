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
import type { AgentId, Item, ItemStatus } from "../schemas/index.js";
import { AgentIdSchema, ItemStatusSchema, ResearchFrontmatterSchema } from "../schemas/index.js";
import type { Command } from "./index.js";

/**
 * Default hard-cap for `radar research --batch`.
 *
 * ADR-0014 D3a pins the default to 10: 2-10x the empirical detection rate
 * (1-5 items per cron tick) while keeping LLM cost-per-tick bounded
 * (~$0.01/item * 10 ~= $0.1). Generated workflow YAML embeds this same
 * literal via `combined.template.yaml`, but the CLI re-enforces it so the
 * cap also applies when the YAML is hand-edited.
 */
export const RESEARCH_BATCH_DEFAULT_MAX_ITEMS = 10;

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
  /** Batch mode (#189 / ADR-0014): research every detected item matching filters. */
  batch?: boolean;
  /** Restrict batch mode to items with this status (default: `detected`). */
  status?: string;
  /** Hard-cap on items processed in batch mode (default: RESEARCH_BATCH_DEFAULT_MAX_ITEMS). */
  maxItems?: string;
  /** Comma-separated allow-list matched against each item's `matchedKeywords`. */
  filterTags?: string;
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
  log(
    `  radar research --batch [--status <status>] [--max-items N] [--filter-tags <list>] [--agent <id>]`,
  );
  log("");
  log("Arguments:");
  log("  <item-id>             Item id (matches items/<sourceId>/<item-id>.yaml)");
  log("                        Pass 2 or more ids together with --digest to bundle them.");
  log("                        Omit positional ids with --batch — items are discovered.");
  log("");
  log("Options:");
  log(
    "  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)",
  );
  log("  --template <id>       Template id under templates/ (default: default; digest: digest)");
  log("  --digest              Bundle multiple items into a single digest report (ADR-0011)");
  log("  --batch               Research every item matching --status (and --filter-tags)");
  log("                        respecting the --max-items hard-cap (ADR-0014 D3a).");
  log("  --status <status>     Batch-mode filter: detected | researched | reviewed | dismissed");
  log("                        (default: detected).");
  log(
    `  --max-items N         Batch-mode hard-cap on processed items (default: ${RESEARCH_BATCH_DEFAULT_MAX_ITEMS}).`,
  );
  log("                        Excess items are dropped and announced via warn() so a runaway");
  log("                        detection cannot blow the cap from inside a workflow.");
  log("  --filter-tags <list>  Batch-mode comma-separated allow-list matched against");
  log("                        each item's matchedKeywords (case-insensitive). Default: all.");
  log("");
  log("Output:");
  log("  single-item:  research/<YYYYMMDD>_<slug>_v1.md (ADR-0003)");
  log("  digest:       research/<YYYYMMDD>_digest_<slug>_v1.md (ADR-0011)");
  log("  batch:        one single-item report per matched item (no digest aggregation).");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

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

function buildDatePrefix(item: Item, now: Date): string {
  const iso = item.publishedAt ?? now.toISOString();
  return iso.slice(0, 10).replace(/-/g, "");
}

function buildDigestDatePrefix(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

function kebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clampSlug(s: string, max = 60): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastHyphen = cut.lastIndexOf("-");
  return lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut;
}

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

async function findItem(cwd: string, itemId: string): Promise<{ item: Item } | null> {
  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) return null;
  const items = await loadItems(itemsDir);
  const match = items.find((i) => i.id === itemId);
  if (!match) return null;
  return { item: match };
}

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

async function resolveAgent(
  cwd: string,
  rawAgent: string | undefined,
  error: (m: string) => void,
): Promise<{ agent: AgentId } | { exitCode: number }> {
  let explicitAgent: AgentId | undefined;
  if (rawAgent !== undefined) {
    const agentResult = AgentIdSchema.safeParse(rawAgent);
    if (!agentResult.success) {
      error(
        `research: invalid --agent '${rawAgent}' (expected: claude-code | codex-cli | gemini-cli | copilot)`,
      );
      return { exitCode: 2 };
    }
    explicitAgent = agentResult.data;
  }
  try {
    const config = await loadRadarConfig(cwd);
    const agent = await getDefaultAgent("research", {
      explicit: explicitAgent,
      configOverride: config,
    });
    return { agent };
  } catch (e) {
    if (e instanceof RadarConfigError) {
      error(`research: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}

async function processResearchInvocation(params: {
  cwd: string;
  items: Item[];
  digest: boolean;
  agent: AgentId;
  templateId: string;
  template: ResearchTemplate;
  now: Date;
  log: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}): Promise<number> {
  const { cwd, items, digest, agent, templateId, template, now, log, warn, error } = params;

  for (const item of items) {
    if (item.injectionFlags.length > 0) {
      warn(
        `research: item '${item.id}' has ${item.injectionFlags.length} injection flag(s): ${item.injectionFlags.join(", ")} (audit-only; use \`radar dismiss\` to skip)`,
      );
    }
  }

  let filename: string;
  if (digest) {
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

  const itemDescription = digest
    ? `${items.length} items (${items.map((i) => i.id).join(", ")})`
    : `item '${items[0].id}'`;
  log(`research: invoking ${agent} adapter for ${itemDescription} -> ${filename}`);

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
    const parsedReport = matter(body, matterOptions);
    const rewritten = matter.stringify(
      parsedReport.content,
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

  const updated: Item[] = items.map((item) =>
    item.status === "detected" ? { ...item, status: "researched" } : item,
  );
  try {
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

function parseMaxItems(raw: string | undefined, error: (m: string) => void): number | null {
  if (raw === undefined) return RESEARCH_BATCH_DEFAULT_MAX_ITEMS;
  if (!/^[0-9]+$/.test(raw)) {
    error(`research: invalid --max-items '${raw}' (expected positive integer)`);
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    error(`research: invalid --max-items '${raw}' (must be > 0)`);
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

async function runResearchBatch(
  parsed: ResearchArgs,
  cwd: string,
  log: (m: string) => void,
  warn: (m: string) => void,
  error: (m: string) => void,
): Promise<number> {
  if (parsed.itemIds.length > 0) {
    error(
      `research: --batch is incompatible with positional <item-id> arguments (got ${parsed.itemIds.length})`,
    );
    return 2;
  }
  if (parsed.digest) {
    error("research: --batch is incompatible with --digest");
    return 2;
  }

  const rawStatus = parsed.status ?? "detected";
  const statusResult = ItemStatusSchema.safeParse(rawStatus);
  if (!statusResult.success) {
    error(
      `research: invalid --status '${rawStatus}' (expected: detected | dismissed | researched | reviewed)`,
    );
    return 2;
  }
  const status: ItemStatus = statusResult.data;

  const maxItems = parseMaxItems(parsed.maxItems, error);
  if (maxItems === null) return 2;
  const filterTags = parseFilterTags(parsed.filterTags);

  const agentResult = await resolveAgent(cwd, parsed.agent, error);
  if ("exitCode" in agentResult) return agentResult.exitCode;
  const agent = agentResult.agent;

  const templateId = parsed.template ?? "default";
  const templatesDir = join(cwd, "templates");
  let template: ResearchTemplate;
  try {
    template = await loadTemplate(templateId, templatesDir);
  } catch (e) {
    error(`research: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const itemsDir = join(cwd, "items");
  const all = await loadItems(itemsDir);
  const lowerFilterTags = filterTags;
  const matches = all
    .filter((it) => it.status === status)
    .filter((it) => {
      if (lowerFilterTags.length === 0) return true;
      const haystack = new Set(it.matchedKeywords.map((k) => k.toLowerCase()));
      return lowerFilterTags.some((t) => haystack.has(t));
    })
    .sort((a, b) => {
      const ap = a.publishedAt ?? a.fetchedAt;
      const bp = b.publishedAt ?? b.fetchedAt;
      if (ap !== bp) return ap < bp ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

  if (matches.length === 0) {
    log(
      `research: no items matched --batch filters (status=${status}${
        filterTags.length > 0 ? `, tags=${filterTags.join(",")}` : ""
      })`,
    );
    return 0;
  }

  let selected = matches;
  if (matches.length > maxItems) {
    const dropped = matches.length - maxItems;
    warn(
      `research: --max-items ${maxItems} cap reached; dropping ${dropped} excess item(s) (matched ${matches.length})`,
    );
    selected = matches.slice(0, maxItems);
  }

  log(
    `research: --batch will process ${selected.length} item(s) (status=${status}${
      filterTags.length > 0 ? `, tags=${filterTags.join(",")}` : ""
    }, agent=${agent}, cap=${maxItems})`,
  );

  const now = new Date();
  for (const item of selected) {
    const exitCode = await processResearchInvocation({
      cwd,
      items: [item],
      digest: false,
      agent,
      templateId,
      template,
      now,
      log,
      warn,
      error,
    });
    if (exitCode !== 0) {
      error(`research: --batch halted on item '${item.id}' (exit ${exitCode})`);
      return exitCode;
    }
  }
  log(`research: --batch completed ${selected.length} item(s)`);
  return 0;
}

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
  if (parsed.batch) {
    return runResearchBatch(parsed, cwd, log, warn, error);
  }
  if (parsed.status !== undefined) {
    error("research: --status requires --batch");
    return 2;
  }
  if (parsed.maxItems !== undefined) {
    error("research: --max-items requires --batch");
    return 2;
  }
  if (parsed.filterTags !== undefined) {
    error("research: --filter-tags requires --batch");
    return 2;
  }
  if (parsed.itemIds.length === 0) {
    error("research: missing <item-id>");
    printHelp(error);
    return 2;
  }
  if (!parsed.digest && parsed.itemIds.length > 1) {
    error(
      `research: multiple <item-id> arguments require --digest (got ${parsed.itemIds.length}: ${parsed.itemIds.join(", ")})`,
    );
    return 2;
  }
  if (parsed.digest && parsed.itemIds.length < 2) {
    error(
      `research: --digest requires 2 or more <item-id> arguments (got ${parsed.itemIds.length})`,
    );
    return 2;
  }

  const agentResult = await resolveAgent(cwd, parsed.agent, error);
  if ("exitCode" in agentResult) return agentResult.exitCode;
  const agent = agentResult.agent;

  const templateId = parsed.template ?? (parsed.digest ? "digest" : "default");

  let items: Item[];
  if (parsed.digest) {
    const result = await findItems(cwd, parsed.itemIds);
    if ("missing" in result) {
      error(`research: item '${result.missing}' not found under items/`);
      return 1;
    }
    items = result.items;
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

  const templatesDir = join(cwd, "templates");
  let template: ResearchTemplate;
  try {
    template = await loadTemplate(templateId, templatesDir);
  } catch (e) {
    error(`research: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  return processResearchInvocation({
    cwd,
    items,
    digest: parsed.digest ?? false,
    agent,
    templateId,
    template,
    now: new Date(),
    log,
    warn,
    error,
  });
}

export const researchCommand: Command = {
  name: "research",
  summary: "Generate Markdown research reports from items via an AI agent",
  run: (args) => runResearch(args),
};
