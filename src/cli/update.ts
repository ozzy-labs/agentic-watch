import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { getAgentAdapter } from "../agents/index.js";
import { getDefaultAgent, loadRadarConfig, RadarConfigError } from "../core/config.js";
import { loadItems } from "../core/items.js";
import type { ResearchTemplate } from "../core/templates.js";
import { loadTemplate } from "../core/templates.js";
import type { AgentId, Item, ResearchFrontmatter } from "../schemas/index.js";
import { AgentIdSchema, ResearchFrontmatterSchema } from "../schemas/index.js";
import type { Command } from "./index.js";

/**
 * gray-matter defaults to js-yaml which auto-converts ISO 8601 strings to
 * `Date` objects. That breaks `ResearchFrontmatterSchema`, which expects
 * timestamps as strings. Swap in the `yaml` v2 engine for parity with the
 * `research` / `review` commands (see src/cli/research.ts for the same
 * rationale).
 */
const matterOptions = {
  engines: {
    yaml: {
      parse: (s: string) => parseYaml(s) as object,
      stringify: (data: object) => stringifyYaml(data),
    },
  },
};

/** Sinks for the update command's user-facing output. Tests inject capturing sinks. */
export interface UpdateIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface UpdateCommandOptions {
  cwd?: string;
  io?: UpdateIO;
}

interface UpdateArgs {
  researchId?: string;
  agent?: string;
  template?: string;
  help?: boolean;
}

function parseArgs(args: string[]): UpdateArgs {
  const out: UpdateArgs = {};
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
  log("Usage: agentic-watch update <research-id> [--agent <agent-id>] [--template <template-id>]");
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
  log("Generates research/<base>_v<n+1>.md from the supplied predecessor id,");
  log("writing `supersedes: <prev id>` into the new file's frontmatter. The");
  log("predecessor file is never modified (immutable history, ADR-0003), and");
  log("the linked items/<id>.yaml `status` is left untouched (ADR-0008).");
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
 * Resolve `<research-id>` to an absolute path under `research/`.
 *
 * Accepts both `<id>` and `<id>.md` for ergonomics. Rejects path-escape
 * attempts (`..`, `/`, `\`) so a malicious id cannot read or write outside
 * the workspace `research/` directory. Mirrors the pattern in
 * `src/cli/review.ts`.
 */
function resolveResearchPath(cwd: string, researchId: string): { id: string; path: string } {
  const id = researchId.endsWith(".md") ? researchId.slice(0, -3) : researchId;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid <research-id>: '${researchId}'`);
  }
  return { id, path: join(cwd, "research", `${id}.md`) };
}

/**
 * Parse the version suffix from a research id.
 *
 * Research filenames follow `<YYYYMMDD>_<slug>_v<N>` (ADR-0003). The base
 * portion (everything before `_v<N>`) is preserved across versions; only the
 * numeric suffix increments. Reject ids that do not match the contract so we
 * fail fast rather than emit a file with a malformed name.
 */
function parseResearchId(id: string): { base: string; version: number } {
  const match = id.match(/^(.+)_v(\d+)$/);
  if (!match) {
    throw new Error(`invalid research id '${id}': expected <base>_v<N> (ADR-0003 filename format)`);
  }
  const version = Number.parseInt(match[2], 10);
  if (!Number.isFinite(version) || version < 1) {
    throw new Error(`invalid version suffix in research id '${id}'`);
  }
  return { base: match[1], version };
}

/**
 * Locate the items/<sourceId>/<itemId>.yaml files for a research file's
 * `itemIds`. Same shape as the helper in `src/cli/review.ts`; we re-implement
 * here (rather than export the review version) because `update` does not need
 * the snapshot/rollback machinery and a duplicated helper keeps the import
 * graph local. Returns `null` when no items dir exists.
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
 * Implementation of `agentic-watch update <research-id>`.
 *
 * High-level flow (Phase 5, [#41](https://github.com/ozzy-labs/agentic-watch/issues/41)):
 *   1. Parse + validate args (agent defaults to `claude-code`, template to `default`).
 *   2. Resolve `research/<research-id>.md` and parse its frontmatter.
 *   3. Compute the new id `<base>_v<n+1>` and refuse to overwrite an existing
 *      `research/<new-id>.md` (idempotent re-runs are user-facing errors).
 *   4. Locate the linked items (read-only; their `status` is preserved per
 *      ADR-0008 / skill-design.md §8.4).
 *   5. Reject `update` when any linked item is in `detected` / `dismissed`
 *      (no v1 research exists, or the user opted out of researching it).
 *   6. Load `templates/<template-id>.md` (empty body when default is absent).
 *   7. Invoke the adapter; the agent writes the new file at `outputPath`.
 *   8. Re-read the new file, validate frontmatter against
 *      `ResearchFrontmatterSchema`, and assert v+1 invariants:
 *      - `id` matches the computed new id
 *      - `itemIds` / `templateId` / `createdAt` preserved from v(N)
 *      - `supersedes` equals the v(N) id
 *      - `reviewedAt` / `reviewedBy` are `null` (review state does NOT carry
 *        across versions per ADR-0003 / skill-design.md §8.3)
 *   9. **No items.yaml mutation** — `update` is intentionally inert wrt item
 *      status. The v1 review event (if any) remains the authoritative record.
 *
 * Unlike `review`, `update` does not snapshot/restore: writing a new file is
 * additive, so a failed adapter just leaves a missing / partial new file that
 * the user can re-run after fixing the underlying issue. The predecessor file
 * is never opened for writing.
 */
export async function runUpdate(
  args: string[],
  options: UpdateCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  let parsed: UpdateArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    error(`update: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printHelp(log);
    return 0;
  }
  if (!parsed.researchId) {
    error("update: missing <research-id>");
    printHelp(error);
    return 2;
  }

  // Resolve the agent honoring the priority chain. We do not yet have a
  // `defaultUpdateAgent` field in `radar.config.yaml` (out of scope for #41
  // per the Issue body), so resolution is:
  //   explicit --agent > defaultResearchAgent > hard-coded claude-code
  // We pick `research` as the borrowed default because `update` shares its
  // SKILL body (rewrite-and-supersede strategy reuses the research procedure;
  // skill-design.md §8.2). When `radar.config.yaml` grows a dedicated
  // `defaultUpdateAgent`, this fallback chain becomes a thin pass-through.
  let explicitAgent: AgentId | undefined;
  if (parsed.agent !== undefined) {
    const agentResult = AgentIdSchema.safeParse(parsed.agent);
    if (!agentResult.success) {
      error(
        `update: invalid --agent '${parsed.agent}' (expected: claude-code | codex-cli | gemini-cli | copilot)`,
      );
      return 2;
    }
    explicitAgent = agentResult.data;
  }
  let agent: AgentId;
  try {
    const config = await loadRadarConfig(cwd);
    agent = await getDefaultAgent("research", {
      explicit: explicitAgent,
      configOverride: config,
    });
  } catch (e) {
    if (e instanceof RadarConfigError) {
      error(`update: ${e.message}`);
      return 2;
    }
    throw e;
  }

  const templateId = parsed.template ?? "default";

  // Resolve predecessor research path.
  let prevId: string;
  let prevPath: string;
  try {
    const resolved = resolveResearchPath(cwd, parsed.researchId);
    prevId = resolved.id;
    prevPath = resolved.path;
  } catch (e) {
    error(`update: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (!(await pathExists(prevPath))) {
    error(`update: research file not found: ${prevPath}`);
    return 1;
  }

  // Parse predecessor frontmatter.
  let prevBody: string;
  try {
    prevBody = await readFile(prevPath, "utf8");
  } catch (e) {
    error(`update: failed to read research file: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let prevFrontmatterRaw: unknown;
  try {
    prevFrontmatterRaw = matter(prevBody, matterOptions).data;
  } catch (e) {
    error(`update: failed to parse frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const prevResult = ResearchFrontmatterSchema.safeParse(prevFrontmatterRaw);
  if (!prevResult.success) {
    error(`update: predecessor frontmatter does not match ResearchFrontmatterSchema:`);
    for (const issue of prevResult.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return 1;
  }
  const prevFm = prevResult.data;

  // Sanity check: the id in the frontmatter must match the filename id so
  // `supersedes: <prev id>` we write below points at a real predecessor.
  if (prevFm.id !== prevId) {
    error(
      `update: predecessor frontmatter id '${prevFm.id}' does not match filename id '${prevId}'`,
    );
    return 1;
  }

  // Compute the new id: increment the version suffix on the predecessor id.
  let base: string;
  let prevVersion: number;
  try {
    const parsedId = parseResearchId(prevId);
    base = parsedId.base;
    prevVersion = parsedId.version;
  } catch (e) {
    error(`update: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const newVersion = prevVersion + 1;
  const newId = `${base}_v${newVersion}`;
  const outputPath = join(cwd, "research", `${newId}.md`);
  if (await pathExists(outputPath)) {
    error(
      `update: ${outputPath} already exists. v${newVersion} was already generated — pick a different predecessor or remove the stale file.`,
    );
    return 1;
  }

  // Resolve linked items. They are needed by the adapter (passed through as
  // context) but `update` does NOT mutate them — per ADR-0008 / ADR-0003 the
  // items.yaml `status` is invariant under update.
  const linkedItems = await findItemsForResearch(cwd, prevFm.itemIds);
  if (linkedItems.length === 0) {
    error(
      `update: no items/<id>.yaml found for itemIds=[${prevFm.itemIds.join(", ")}] referenced by ${prevFm.id}`,
    );
    return 1;
  }
  if (linkedItems.length !== prevFm.itemIds.length) {
    const found = new Set(linkedItems.map((i) => i.id));
    const missing = prevFm.itemIds.filter((id) => !found.has(id));
    error(
      `update: ${missing.length} linked item(s) not found: ${missing.join(", ")} (referenced by ${prevFm.id})`,
    );
    return 1;
  }
  // Per skill-design.md §8.4, `update` requires an existing research file —
  // i.e. the item must have been at `researched` or `reviewed` at some point.
  // We block `detected` / `dismissed` because there is no v1 to supersede in
  // those states (research never happened, or the user opted out).
  const invalidStatus = linkedItems.filter(
    (i) => i.status !== "researched" && i.status !== "reviewed",
  );
  if (invalidStatus.length > 0) {
    error(
      `update: linked items must be in status 'researched' or 'reviewed'. Offenders: ${invalidStatus
        .map((i) => `${i.id}=${i.status}`)
        .join(", ")}`,
    );
    return 1;
  }

  // Surface any prompt-injection pre-filter hits recorded by the watcher
  // (ADR-0009 M1a / M5a — Adopt). Audit-only: `update` still generates a v+1
  // from possibly tainted content, but the user gets the audit signal before
  // spending tokens on the regeneration pass.
  for (const linked of linkedItems) {
    if (linked.injectionFlags.length > 0) {
      warn(
        `update: item '${linked.id}' has ${linked.injectionFlags.length} injection flag(s): ${linked.injectionFlags.join(", ")} (audit-only; v+1 will regenerate research from the same source content)`,
      );
    }
  }

  // Load template.
  const templatesDir = join(cwd, "templates");
  let template: ResearchTemplate;
  try {
    template = await loadTemplate(templateId, templatesDir);
  } catch (e) {
    error(`update: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  log(`update: invoking ${agent} adapter for research '${prevFm.id}' -> ${base}_v${newVersion}.md`);

  // Invoke adapter. We do not snapshot the predecessor file: the adapter
  // writes a new file at outputPath; if it fails, no rollback is necessary
  // because the predecessor was never touched and the new file simply does
  // not appear (or is partial, in which case the user removes it and retries).
  const adapter = getAgentAdapter(agent);
  try {
    await adapter.update({
      agent,
      templateId,
      templateBody: template.body,
      prevResearch: {
        frontmatter: prevFm,
        body: prevBody,
      },
      items: linkedItems,
      outputPath,
      cwd,
    });
  } catch (e) {
    error(`update: adapter failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Re-read and validate the produced file.
  if (!(await pathExists(outputPath))) {
    error(
      `update: adapter completed but did not write ${outputPath} (agent ignored the output path?)`,
    );
    return 1;
  }
  let newBody: string;
  try {
    newBody = await readFile(outputPath, "utf8");
  } catch (e) {
    error(`update: failed to read generated report: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let newFrontmatterRaw: unknown;
  try {
    newFrontmatterRaw = matter(newBody, matterOptions).data;
  } catch (e) {
    error(`update: failed to parse new frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const newResult = ResearchFrontmatterSchema.safeParse(newFrontmatterRaw);
  if (!newResult.success) {
    error(`update: new frontmatter does not match ResearchFrontmatterSchema:`);
    for (const issue of newResult.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return 1;
  }
  const newFm = newResult.data;

  // v+1 invariants. We enforce these in the CLI so a misbehaving agent
  // cannot silently corrupt the versioning chain. Drift is collected before
  // we attempt repair, then a single corrected file is written.
  const drift: string[] = [];
  if (newFm.id !== newId) drift.push(`id (${newId} expected, got ${newFm.id})`);
  if (JSON.stringify(newFm.itemIds) !== JSON.stringify(prevFm.itemIds))
    drift.push(`itemIds (${prevFm.itemIds.join(",")} -> ${newFm.itemIds.join(",")})`);
  if (newFm.templateId !== prevFm.templateId)
    drift.push(`templateId (${prevFm.templateId} -> ${newFm.templateId})`);
  if (newFm.createdAt !== prevFm.createdAt)
    drift.push(`createdAt (${prevFm.createdAt} -> ${newFm.createdAt})`);
  if (newFm.supersedes !== prevFm.id)
    drift.push(`supersedes (expected '${prevFm.id}', got '${newFm.supersedes ?? "null"}')`);
  if (newFm.reviewedAt !== null)
    drift.push(`reviewedAt (expected null on v+1, got ${newFm.reviewedAt})`);
  if (newFm.reviewedBy !== null)
    drift.push(`reviewedBy (expected null on v+1, got ${newFm.reviewedBy})`);

  // The agent field may legitimately differ from v(N) when the user runs
  // `update` with a different --agent (skill-design.md §8.3 marks `agent` as
  // mutable across versions). We assert it matches the invoking agent so a
  // misbehaving adapter cannot lie about who produced the v+1.
  if (newFm.agent !== agent)
    drift.push(`agent (expected '${agent}' for v+1 write, got '${newFm.agent}')`);

  if (drift.length > 0) {
    warn(`update: agent emitted drift in frontmatter; auto-correcting: ${drift.join("; ")}`);
    const parsedDoc = matter(newBody, matterOptions);
    const corrected: ResearchFrontmatter = {
      id: newId,
      itemIds: prevFm.itemIds,
      agent,
      templateId: prevFm.templateId,
      createdAt: prevFm.createdAt,
      updatedAt: newFm.updatedAt ?? new Date().toISOString(),
      reviewedAt: null,
      reviewedBy: null,
      supersedes: prevFm.id,
    };
    const rewritten = matter.stringify(parsedDoc.content, corrected, matterOptions);
    await writeFile(outputPath, rewritten, "utf8");
  }

  log(`update: wrote ${outputPath}`);
  log(`update: supersedes ${prevFm.id} (items.yaml status unchanged per ADR-0008)`);
  return 0;
}

export const updateCommand: Command = {
  name: "update",
  summary: "Refresh existing research reports against the latest items",
  run: (args) => runUpdate(args),
};
