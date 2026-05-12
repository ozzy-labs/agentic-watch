import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { getAgentAdapter } from "../agents/index.js";
import { getDefaultAgent, loadRadarConfig, RadarConfigError } from "../core/config.js";
import { loadItems, saveItems } from "../core/items.js";
import type { ResearchTemplate } from "../core/templates.js";
import { loadTemplate } from "../core/templates.js";
import type { AgentId, Item } from "../schemas/index.js";
import { AgentIdSchema, ResearchFrontmatterSchema } from "../schemas/index.js";
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
}

interface ReviewArgs {
  researchId?: string;
  agent?: string;
  template?: string;
  help?: boolean;
}

function parseArgs(args: string[]): ReviewArgs {
  const out: ReviewArgs = {};
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
    if (!out.researchId) {
      out.researchId = a;
      continue;
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

function printHelp(log: (m: string) => void): void {
  log("Usage: agentic-watch review <research-id> [--agent <agent-id>] [--template <template-id>]");
  log("");
  log("Arguments:");
  log("  <research-id>         Research id (basename of research/<id>.md without .md)");
  log("");
  log("Options:");
  log(
    "  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)",
  );
  log("  --template <id>       Template id under templates/ (default: default)");
  log("");
  log("Appends a review block to research/<research-id>.md, stamps the");
  log("frontmatter `reviewedAt` / `reviewedBy`, and transitions the linked");
  log("items/<id>.yaml `status` from `researched` to `reviewed`. Both updates");
  log("happen atomically — a partial failure rolls back the research file.");
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
 * Implementation of `agentic-watch review <research-id>`.
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

  let parsed: ReviewArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    error(`review: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printHelp(log);
    return 0;
  }
  if (!parsed.researchId) {
    error("review: missing <research-id>");
    printHelp(error);
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
      error(
        `review: invalid --agent '${parsed.agent}' (expected: claude-code | codex-cli | gemini-cli | copilot)`,
      );
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
  // Phase 2 sub-issues B / C / E ship claude-code, codex-cli, copilot.
  // gemini-cli lands in sub-issue D; its adapter still throws "not
  // implemented", so reject it here with a friendlier message and avoid
  // leaking adapter-level wording.
  if (agent !== "claude-code" && agent !== "codex-cli" && agent !== "copilot") {
    error(
      `review: agent '${agent}' is not supported yet (available: claude-code, codex-cli, copilot)`,
    );
    return 2;
  }

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
    error(`review: research file not found: ${researchPath}`);
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
      `review: research '${preFm.id}' is already reviewed (reviewedAt=${preFm.reviewedAt}, reviewedBy=${preFm.reviewedBy})`,
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

  // Load template.
  const templatesDir = join(cwd, "templates");
  let template: ResearchTemplate;
  try {
    template = await loadTemplate(templateId, templatesDir);
  } catch (e) {
    error(`review: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
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
    });
  } catch (e) {
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
  // misbehaving agent that rewrote `id` / `itemIds` / `agent` / `createdAt`
  // here is cheaper than letting the inconsistency leak downstream.
  const drift: string[] = [];
  if (postFm.id !== preFm.id) drift.push(`id (${preFm.id} -> ${postFm.id})`);
  if (postFm.agent !== preFm.agent) drift.push(`agent (${preFm.agent} -> ${postFm.agent})`);
  if (postFm.templateId !== preFm.templateId)
    drift.push(`templateId (${preFm.templateId} -> ${postFm.templateId})`);
  if (postFm.createdAt !== preFm.createdAt)
    drift.push(`createdAt (${preFm.createdAt} -> ${postFm.createdAt})`);
  if (JSON.stringify(postFm.itemIds) !== JSON.stringify(preFm.itemIds))
    drift.push(`itemIds (${preFm.itemIds.join(",")} -> ${postFm.itemIds.join(",")})`);
  if (drift.length > 0) {
    error(`review: adapter mutated immutable frontmatter fields: ${drift.join("; ")}`);
    await restoreSnapshot(snapshot);
    return 1;
  }

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

  log(`review: stamped ${researchPath} reviewedAt=${postFm.reviewedAt} reviewedBy=${agent}`);
  for (const item of updatedItems) {
    log(`review: items/${item.sourceId}/${item.id}.yaml status -> reviewed`);
  }
  return 0;
}

export const reviewCommand: Command = {
  name: "review",
  summary: "Cross-review existing research reports using a different AI agent",
  run: (args) => runReview(args),
};
