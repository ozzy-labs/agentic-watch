import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { renderUpdatePayloadBlock } from "../agents/_boundary.js";
import { getAgentAdapter } from "../agents/index.js";
import { getDefaultAgent, loadRadarConfig, RadarConfigError } from "../core/config.js";
import { loadItems } from "../core/items.js";
import type { ProgressReporter } from "../core/progress.js";
import type { ResearchTemplate } from "../core/templates.js";
import { loadTemplate } from "../core/templates.js";
import type { AgentId, Item, ResearchFrontmatter } from "../schemas/index.js";
import { AgentIdSchema, ResearchFrontmatterSchema } from "../schemas/index.js";
import { resolveCommitPathInside } from "./_commit-path.js";
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
  /**
   * Test-only override for the {@link ProgressReporter}. When omitted, the
   * CLI constructs one from `--verbose` / `--quiet` / `RADAR_NO_PROGRESS`
   * (ADR-0015 D2).
   */
  progress?: ProgressReporter;
}

interface UpdateArgs {
  researchId?: string;
  agent?: string;
  template?: string;
  help?: boolean;
  /**
   * Host-agent mode (#254 / ADR-0019): emit the update payload to stdout
   * without spawning an agent. The host (interactive) session runs the SKILL
   * procedure itself, then finalizes via `--commit`.
   */
  emitPayload?: boolean;
  /**
   * Host-agent mode (#254 / ADR-0019): finalize an externally-written v+1
   * report. Holds the path the host session wrote. The CLI validates it
   * against `ResearchFrontmatterSchema`, asserts the v+1 invariants against the
   * predecessor named by `supersedes`, and leaves items.yaml untouched
   * (ADR-0008).
   */
  commit?: string;
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

function printHelp(log: (m: string) => void): void {
  log("Usage:");
  log("  radar update <research-id> [--agent <agent-id>] [--template <template-id>]");
  log("  radar update <research-id> --emit-payload [--template <id>]");
  log("  radar update --commit <path>");
  log("");
  log("Arguments:");
  log("  <research-id>         Research id (basename of research/<id>.md without .md)");
  log("");
  log("Options:");
  log(
    "  --agent <agent-id>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)",
  );
  log("  --template <id>       Template id under templates/ (default: default)");
  log("  --emit-payload        Host-agent mode: print the update payload to");
  log("                        stdout and DO NOT spawn an agent. The interactive host");
  log("                        session runs the SKILL procedure itself, then finalizes");
  log("                        with `radar update --commit <path>`. Interactive/opt-in");
  log("                        only — CI/headless must use the default spawn path.");
  log("  --commit <path>       Host-agent mode: validate an externally-written");
  log("                        v+1 report (under <cwd>/research/) against ResearchFrontmatter-");
  log("                        Schema, assert the v+1 invariants against the `supersedes`");
  log("                        predecessor, and leave items.yaml untouched.");
  log("  --verbose             Stream the agent CLI's stdout/stderr in addition to phase markers.");
  log(
    "  --quiet               Suppress phase markers and spinner; print only the completion line.",
  );
  log("                        Equivalent to setting RADAR_NO_PROGRESS=1.");
  log("");
  log("Generates research/<base>_v<n+1>.md from the supplied predecessor id,");
  log("writing `supersedes: <prev id>` into the new file's frontmatter. The");
  log("predecessor file is never modified (immutable history), and");
  log("the linked items/<id>.yaml `status` is left untouched.");
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
    throw new Error(`invalid research id '${id}': expected <base>_v<N> filename format`);
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
 * Resolve the effective agent honoring the priority chain
 * (`explicit --agent > defaultResearchAgent > hard-coded claude-code`).
 *
 * `update` borrows the `research` default because it shares the research SKILL
 * body (rewrite-and-supersede strategy; skill-design.md §8.2). Extracted from
 * the spawn path so the host-agent emit path resolves the same agent without
 * duplicating the priority chain.
 */
async function resolveUpdateAgent(
  cwd: string,
  rawAgent: string | undefined,
  error: (m: string) => void,
): Promise<{ agent: AgentId } | { exitCode: number }> {
  let explicitAgent: AgentId | undefined;
  if (rawAgent !== undefined) {
    const agentResult = AgentIdSchema.safeParse(rawAgent);
    if (!agentResult.success) {
      error(
        `update: invalid --agent '${rawAgent}' (expected: claude-code | codex-cli | gemini-cli | copilot)`,
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
      error(`update: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}

/** Resolved predecessor + derived v+1 target, shared by the spawn and emit paths. */
interface PreparedUpdate {
  prevId: string;
  prevBody: string;
  prevFm: ResearchFrontmatter;
  base: string;
  newVersion: number;
  newId: string;
  outputPath: string;
  linkedItems: Item[];
}

/**
 * PRE block (shared by the spawn path and `--emit-payload`): resolve the
 * predecessor research, validate its frontmatter, compute the deterministic
 * v+1 `outputPath`, guard against overwriting an existing v+1, and resolve the
 * linked items (read-only — their status is invariant under update, ADR-0008).
 *
 * Extracted from `runUpdate` so the host-agent emit path (#254 / ADR-0019)
 * derives the exact same `newId` / `outputPath` and reuses the same collision +
 * status guards as the spawn path, without the model-call step.
 */
async function prepareUpdate(params: {
  cwd: string;
  researchId: string;
  warn: (m: string) => void;
  error: (m: string) => void;
  progress: ProgressReporter;
}): Promise<PreparedUpdate | { exitCode: number }> {
  const { cwd, researchId, warn, error, progress } = params;

  // Resolve predecessor research path.
  let prevId: string;
  let prevPath: string;
  try {
    const resolved = resolveResearchPath(cwd, researchId);
    prevId = resolved.id;
    prevPath = resolved.path;
  } catch (e) {
    error(`update: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 2 };
  }
  if (!(await pathExists(prevPath))) {
    error(`update: research file not found: ${prevPath}`);
    return { exitCode: 1 };
  }

  // Parse predecessor frontmatter.
  let prevBody: string;
  try {
    prevBody = await readFile(prevPath, "utf8");
  } catch (e) {
    error(`update: failed to read research file: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }
  let prevFrontmatterRaw: unknown;
  try {
    prevFrontmatterRaw = matter(prevBody, matterOptions).data;
  } catch (e) {
    error(`update: failed to parse frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }
  const prevResult = ResearchFrontmatterSchema.safeParse(prevFrontmatterRaw);
  if (!prevResult.success) {
    error(`update: predecessor frontmatter does not match ResearchFrontmatterSchema:`);
    for (const issue of prevResult.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return { exitCode: 1 };
  }
  const prevFm = prevResult.data;

  // Sanity check: the id in the frontmatter must match the filename id so
  // `supersedes: <prev id>` we write below points at a real predecessor.
  if (prevFm.id !== prevId) {
    error(
      `update: predecessor frontmatter id '${prevFm.id}' does not match filename id '${prevId}'`,
    );
    return { exitCode: 1 };
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
    return { exitCode: 1 };
  }
  const newVersion = prevVersion + 1;
  const newId = `${base}_v${newVersion}`;
  const outputPath = join(cwd, "research", `${newId}.md`);
  if (await pathExists(outputPath)) {
    error(
      `update: ${outputPath} already exists. v${newVersion} was already generated — pick a different predecessor or remove the stale file.`,
    );
    return { exitCode: 1 };
  }

  // Resolve linked items. They are needed by the adapter (passed through as
  // context) but `update` does NOT mutate them — per ADR-0008 / ADR-0003 the
  // items.yaml `status` is invariant under update.
  const linkedItems = await findItemsForResearch(cwd, prevFm.itemIds);
  if (linkedItems.length === 0) {
    error(
      `update: no items/<id>.yaml found for itemIds=[${prevFm.itemIds.join(", ")}] referenced by ${prevFm.id}`,
    );
    return { exitCode: 1 };
  }
  if (linkedItems.length !== prevFm.itemIds.length) {
    const found = new Set(linkedItems.map((i) => i.id));
    const missing = prevFm.itemIds.filter((id) => !found.has(id));
    error(
      `update: ${missing.length} linked item(s) not found: ${missing.join(", ")} (referenced by ${prevFm.id})`,
    );
    return { exitCode: 1 };
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
    return { exitCode: 1 };
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

  // Phase marker: items resolved.
  progress.phase(
    linkedItems.length === 1
      ? `Loaded item: ${linkedItems[0].id}`
      : `Loaded ${linkedItems.length} items`,
    linkedItems.map((i) => i.id).join(", "),
  );

  return { prevId, prevBody, prevFm, base, newVersion, newId, outputPath, linkedItems };
}

/**
 * POST block (shared by the spawn path and `--commit`): re-read the written
 * v+1 report, validate it against `ResearchFrontmatterSchema`, assert the v+1
 * invariants against the predecessor frontmatter (auto-correcting drift), and
 * deliberately leave items.yaml untouched (ADR-0008).
 *
 * This is the single source of truth for "finalize an update" so the spawn and
 * host-agent paths (#254 / ADR-0019) cannot diverge on schema validation, the
 * supersedes/createdAt/itemIds drift checks, or the items.yaml status
 * invariance — the CLI keeps owning those regardless of who wrote the file.
 *
 * `linkedItems` is optional: the spawn path passes the items it already
 * resolved (drives the status phase marker); `--commit` omits it because the
 * commit path validates the on-disk file without re-loading items (status is
 * never mutated either way).
 */
async function finalizeUpdate(params: {
  outputPath: string;
  prevFm: ResearchFrontmatter;
  newId: string;
  agent: AgentId;
  linkedItems?: Item[];
  log: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  progress: ProgressReporter;
}): Promise<number> {
  const { outputPath, prevFm, newId, agent, linkedItems, log, warn, error, progress } = params;

  if (!(await pathExists(outputPath))) {
    error(`update: did not write ${outputPath} (agent / host ignored the output path?)`);
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

  // v+1 invariants. We enforce these in the CLI so a misbehaving agent / host
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
  // Phase marker emitted after the optional auto-correction so the user sees
  // "validated" only once the on-disk file is known to satisfy the schema.
  progress.phase("Frontmatter validated");
  // `update` deliberately preserves items.yaml status (ADR-0008). We still
  // surface a status phase marker so the progress stream stays uniform with
  // research / review — the value just records the no-op transition. The
  // commit path has no resolved linked items, so it skips the per-item marker.
  if (linkedItems !== undefined && linkedItems.length > 0) {
    progress.phase(
      `Status: ${linkedItems[0].status} → ${linkedItems[0].status}`,
      "items.yaml unchanged",
    );
  }

  log(`update: wrote ${outputPath}`);
  log(`update: supersedes ${prevFm.id} (items.yaml status unchanged)`);
  return 0;
}

/**
 * Host-agent emit path (#254 / ADR-0019): run the same PRE block as the spawn
 * path (`prepareUpdate`) to derive `outputPath` + predecessor context, then
 * print the agent-neutral payload to stdout instead of spawning. The host
 * session reads the payload, executes the SKILL procedure itself, and finalizes
 * via `radar update --commit`.
 */
async function runUpdateEmitPayload(params: {
  cwd: string;
  researchId: string;
  agent: AgentId;
  templateId: string;
  log: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  progress: ProgressReporter;
}): Promise<number> {
  const { cwd, researchId, agent, templateId, log, warn, error, progress } = params;
  const prepared = await prepareUpdate({ cwd, researchId, warn, error, progress });
  if ("exitCode" in prepared) return prepared.exitCode;

  const templatesDir = join(cwd, "templates");
  let template: ResearchTemplate;
  try {
    template = await loadTemplate(templateId, templatesDir);
  } catch (e) {
    error(`update: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  progress.phase(`Loaded template: ${templateId}.md`);

  log(
    renderUpdatePayloadBlock({
      agent,
      templateId,
      templateBody: template.body,
      prevResearch: { frontmatter: prepared.prevFm, body: prepared.prevBody },
      items: prepared.linkedItems,
      outputPath: prepared.outputPath,
    }),
  );
  return 0;
}

/**
 * Host-agent commit path (#254 / ADR-0019): finalize a v+1 report the host
 * session wrote out-of-band. The report is self-describing via its `supersedes`
 * frontmatter, which names the predecessor; we read `research/<supersedes>.md`
 * to recover the v(N) frontmatter and run the same drift checks as the spawn
 * path. `supersedes: null` is rejected — update always has a predecessor.
 *
 * Before finalize, the committed path is constrained to `<cwd>/research/` so a
 * host misled by injected content into committing an arbitrary path (e.g.
 * `../../etc/...`) is rejected at the CLI boundary (ADR-0009 M3b enforced in
 * code, not just SKILL guidance).
 */
async function runUpdateCommit(params: {
  cwd: string;
  commitPath: string;
  log: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  progress: ProgressReporter;
}): Promise<number> {
  const { cwd, commitPath, log, warn, error, progress } = params;
  const guard = await resolveCommitPathInside(cwd, "research", commitPath);
  if ("error" in guard) {
    error(`update: ${guard.error}`);
    return 2;
  }
  const outputPath = guard.resolved;

  if (!(await pathExists(outputPath))) {
    error(`update: report was not written to ${outputPath} (did not write the output path?)`);
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

  // `supersedes` names the predecessor. Update always has one (it generates
  // v+1 from v(N)); a null supersedes means the host wrote a v1, which is a
  // `research` artifact, not an `update` artifact.
  if (newFm.supersedes === null) {
    error(
      "update: --commit report has `supersedes: null`. update finalizes a v+1 (use `radar research --commit` for a v1).",
    );
    return 1;
  }

  // Recover the predecessor frontmatter from research/<supersedes>.md so the
  // drift checks (createdAt / itemIds preservation, supersedes wiring) run
  // against the real v(N), exactly as the spawn path does.
  let prevPath: string;
  try {
    prevPath = resolveResearchPath(cwd, newFm.supersedes).path;
  } catch (e) {
    error(
      `update: invalid supersedes id in committed report: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  if (!(await pathExists(prevPath))) {
    error(
      `update: predecessor research/${newFm.supersedes}.md (named by supersedes) not found under ${cwd}`,
    );
    return 1;
  }
  let prevBody: string;
  try {
    prevBody = await readFile(prevPath, "utf8");
  } catch (e) {
    error(
      `update: failed to read predecessor research file: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  const prevResult = ResearchFrontmatterSchema.safeParse(matter(prevBody, matterOptions).data);
  if (!prevResult.success) {
    error(`update: predecessor frontmatter does not match ResearchFrontmatterSchema:`);
    for (const issue of prevResult.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return 1;
  }
  const prevFm = prevResult.data;
  if (prevFm.id !== newFm.supersedes) {
    error(
      `update: predecessor frontmatter id '${prevFm.id}' does not match supersedes '${newFm.supersedes}'`,
    );
    return 1;
  }

  // The expected new id is the basename of the committed file. finalizeUpdate
  // re-validates the frontmatter id against it (drift auto-correction).
  const newId = outputPath.replace(/^.*\//, "").replace(/\.md$/, "");

  // Version monotonicity: the committed filename must be exactly one version
  // above the predecessor of the same base, mirroring the spawn path which
  // derives `newId = <base>_v<prev+1>` deterministically. Without this a host
  // — possibly misled by injected content — could commit `foo_v9.md`
  // superseding `foo_v2.md` and skip versions, breaking the ADR-0003 lineage
  // contract. parseResearchId throws on a malformed predecessor id; that is a
  // corrupt workspace, surfaced as an error rather than a silent pass.
  let prevParsed: { base: string; version: number };
  try {
    prevParsed = parseResearchId(prevFm.id);
  } catch (e) {
    error(
      `update: predecessor id '${prevFm.id}' is not a valid <base>_v<n> id: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  const expectedNewId = `${prevParsed.base}_v${prevParsed.version + 1}`;
  if (newId !== expectedNewId) {
    error(
      `update: committed report '${newId}' must be '${expectedNewId}' — exactly v${prevParsed.version + 1} of '${prevParsed.base}' (predecessor '${prevFm.id}'). update finalizes a single version increment.`,
    );
    return 1;
  }
  // The committed file's `agent` is authoritative for the commit path: there is
  // no `--agent` flag in play, so we accept whatever valid agent the host
  // stamped (still schema-validated by ResearchFrontmatterSchema above).
  return finalizeUpdate({
    outputPath,
    prevFm,
    newId,
    agent: newFm.agent,
    linkedItems: undefined,
    log,
    warn,
    error,
    progress,
  });
}

/**
 * Implementation of `radar update <research-id>`.
 *
 * High-level flow (Phase 5, [#41](https://github.com/ozzy-labs/feedradar/issues/41)):
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

  // Two-stage argv parse (see `src/cli/research.ts` for the full rationale).
  let progressState: ReturnType<typeof parseProgressFlags>;
  try {
    progressState = parseProgressFlags(args);
  } catch (e) {
    if (e instanceof ProgressFlagError) {
      error(`update: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const progress = options.progress ?? buildReporter({ level: progressState.level });

  let parsed: UpdateArgs;
  try {
    parsed = parseArgs(progressState.rest);
  } catch (e) {
    error(`update: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printHelp(log);
    return 0;
  }

  // Host-agent commit (#254 / ADR-0019). Independent of agent / template /
  // predecessor resolution: the report is self-describing via its `supersedes`
  // frontmatter. Handled before the other modes since it takes a path, not a
  // <research-id>.
  if (parsed.commit !== undefined) {
    if (parsed.emitPayload) {
      error("update: --commit is incompatible with --emit-payload");
      return 2;
    }
    if (parsed.researchId !== undefined) {
      error(`update: --commit takes a <path>, not a <research-id> (got '${parsed.researchId}')`);
      return 2;
    }
    return runUpdateCommit({ cwd, commitPath: parsed.commit, log, warn, error, progress });
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
  const agentResult = await resolveUpdateAgent(cwd, parsed.agent, error);
  if ("exitCode" in agentResult) return agentResult.exitCode;
  const agent = agentResult.agent;

  const templateId = parsed.template ?? "default";

  // Host-agent emit (#254 / ADR-0019): same predecessor / item resolution as
  // the spawn path (`prepareUpdate`), but print the payload instead of
  // spawning the adapter.
  if (parsed.emitPayload) {
    return runUpdateEmitPayload({
      cwd,
      researchId: parsed.researchId,
      agent,
      templateId,
      log,
      warn,
      error,
      progress,
    });
  }

  // PRE block (shared with --emit-payload): resolve predecessor, compute the
  // v+1 outputPath, collision-check, and resolve linked items.
  const prepared = await prepareUpdate({
    cwd,
    researchId: parsed.researchId,
    warn,
    error,
    progress,
  });
  if ("exitCode" in prepared) return prepared.exitCode;
  const { prevFm, prevBody, base, newVersion, newId, outputPath, linkedItems } = prepared;

  // Load template.
  const templatesDir = join(cwd, "templates");
  let template: ResearchTemplate;
  try {
    template = await loadTemplate(templateId, templatesDir);
  } catch (e) {
    error(`update: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  progress.phase(`Loaded template: ${templateId}.md`);

  log(`update: invoking ${agent} adapter for research '${prevFm.id}' -> ${base}_v${newVersion}.md`);

  // Phase marker + spinner for the agent run. See `research.ts` for the
  // shared pattern.
  progress.phase(`Spawning ${agent}`, `cwd: ${cwd}`);
  progress.start("Agent running");
  const adapterStartedAt = Date.now();
  const polling = pollOutputFileSize({ path: outputPath, reporter: progress });

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
      onProgress: buildAgentProgressCallback(progress),
    });
  } catch (e) {
    polling.stop();
    progress.fail("Agent failed", e instanceof Error ? e.message : String(e));
    error(`update: adapter failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  polling.stop();
  progress.succeed("Agent completed (exit 0)", Date.now() - adapterStartedAt);

  // POST block (shared with --commit): re-read, validate, drift-correct, log.
  return finalizeUpdate({
    outputPath,
    prevFm,
    newId,
    agent,
    linkedItems,
    log,
    warn,
    error,
    progress,
  });
}

export const updateCommand: Command = {
  name: "update",
  summary: "Refresh existing research reports against the latest items",
  run: (args) => runUpdate(args),
};
