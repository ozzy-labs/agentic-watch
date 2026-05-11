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
  itemId?: string;
  agent?: string;
  template?: string;
  help?: boolean;
}

function parseArgs(args: string[]): ResearchArgs {
  const out: ResearchArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
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
    if (!out.itemId) {
      out.itemId = a;
      continue;
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

function printHelp(log: (m: string) => void): void {
  log("Usage: agentic-watch research <item-id> [--agent <agent-id>] [--template <template-id>]");
  log("");
  log("Arguments:");
  log("  <item-id>             Item id (matches items/<sourceId>/<item-id>.yaml)");
  log("");
  log("Options:");
  log(
    "  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)",
  );
  log("  --template <id>       Template id under templates/ (default: default)");
  log("");
  log("Writes research/<YYYYMMDD>_<slug>_v1.md (ADR-0003).");
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
 * Implementation of `agentic-watch research <item-id>`.
 *
 * High-level flow (Phase 1):
 *   1. Parse + validate args (agent defaults to `claude-code`, template to `default`).
 *   2. Locate `items/<sourceId>/<item-id>.yaml` and parse it.
 *   3. Load `templates/<template-id>.md` (empty body when default is absent).
 *   4. Compute `research/<YYYYMMDD>_<slug>_v1.md`; refuse to overwrite an
 *      existing file (re-runs go through `update` per ADR-0003).
 *   5. Invoke the registered agent adapter; the agent writes the report.
 *   6. Validate the report's frontmatter against `ResearchFrontmatterSchema`.
 *   7. Transition the item: `status` → `researched` and persist.
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
  if (!parsed.itemId) {
    error("research: missing <item-id>");
    printHelp(error);
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
  if (agent !== "claude-code") {
    // Phase 1 ships claude-code only. Other adapter stubs throw their own
    // "not implemented" error; this earlier rejection gives a friendlier
    // message and avoids leaking adapter-level wording.
    error(`research: agent '${agent}' is not supported in Phase 1 (claude-code only)`);
    return 2;
  }

  const templateId = parsed.template ?? "default";

  // Locate the item.
  const found = await findItem(cwd, parsed.itemId);
  if (!found) {
    error(`research: item '${parsed.itemId}' not found under items/`);
    return 1;
  }
  const { item } = found;

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
  // through `agentic-watch update` per ADR-0003 (immutable history).
  const now = new Date();
  const datePrefix = buildDatePrefix(item, now);
  const slug = buildSlug(item);
  const filename = `${datePrefix}_${slug}_v1.md`;
  const outputPath = join(cwd, "research", filename);
  if (await pathExists(outputPath)) {
    error(`research: ${outputPath} already exists (use \`agentic-watch update\` to re-research)`);
    return 1;
  }

  log(`research: invoking ${agent} adapter for item '${item.id}' -> ${filename}`);

  // Invoke adapter.
  const adapter = getAgentAdapter(agent);
  try {
    await adapter.research({
      agent,
      templateId,
      templateBody: template.body,
      items: [item],
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
  if (fmResult.data.reviewedAt !== null || fmResult.data.reviewedBy !== null) {
    warn(
      "research: agent populated reviewedAt/reviewedBy; resetting to null (Phase 1 contract — review handles this in Phase 2)",
    );
    const parsed = matter(body, matterOptions);
    const rewritten = matter.stringify(
      parsed.content,
      {
        ...fmResult.data,
        reviewedAt: null,
        reviewedBy: null,
      },
      matterOptions,
    );
    await writeFile(outputPath, rewritten, "utf8");
  }

  // Transition item status.
  const updated: Item = { ...item, status: "researched" };
  try {
    // saveItems writes by sourceId+id, so it will overwrite the existing file
    // in place. We rely on this rather than constructing the path manually.
    await saveItems(join(cwd, "items"), [updated]);
  } catch (e) {
    error(`research: failed to update item status: ${e instanceof Error ? e.message : String(e)}`);
    error(`  (research file was written: ${outputPath})`);
    return 1;
  }

  log(`research: wrote ${outputPath}`);
  log(`research: items/${item.sourceId}/${item.id}.yaml status -> researched`);
  return 0;
}

export const researchCommand: Command = {
  name: "research",
  summary: "Generate Markdown research reports from items via an AI agent",
  run: (args) => runResearch(args),
};
