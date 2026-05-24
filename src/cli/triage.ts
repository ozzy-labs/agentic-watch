import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { renderTriagePayloadBlock } from "../agents/_boundary.js";
import { loadItems, saveItems } from "../core/items.js";
import { createProgressReporter, type ProgressLevel } from "../core/progress.js";
import { statusForTriageDecision } from "../core/transitions.js";
import {
  buildTriagePrompt,
  parseTriageResponse,
  TriageResponseParseError,
  type TriageResult,
  type TriageRunner,
  triageItems,
} from "../core/triage/index.js";
import { loadSources } from "../core/watcher.js";
import type { DismissedBy, Item, TriageDecision } from "../schemas/item.js";
import { TriageDecisionValueSchema } from "../schemas/item.js";
import { AgentIdSchema } from "../schemas/research.js";
import type { Source, SourceTriagePolicy } from "../schemas/source.js";
import { SourceTriagePolicySchema } from "../schemas/source.js";
import { resolveCommitPathInside } from "./_commit-path.js";
import type { Command } from "./index.js";

/**
 * `radar triage` and `radar triage feedback` CLI implementations (ADR-0018 PR-3).
 *
 * The CLI is a thin wrapper around `core/triage/index.ts > triageItems()` that:
 *
 * 1. Loads `detected` items from `items/`, optionally narrowing by
 *    `--source` / `--filter-tags` / `--max-items`.
 * 2. Resolves the per-source `triagePolicy` (either from `sources/<id>.yaml`
 *    or from `--policy <path>`).
 * 3. Calls `triageItems()` once per source (each source has its own policy /
 *    agent, so batching cross-source would either lose policy nuance or
 *    require a multi-policy prompt — neither worth the complexity).
 * 4. Either prints the proposed decisions (`--dry-run`), opens `$EDITOR` to
 *    let the user massage them (`--interactive`), or writes them to disk
 *    (`--apply`).
 *
 * `radar triage feedback` is a separate path that mutates the `triage.feedback`
 * array on a single item — no agent call, no policy resolution.
 */

export interface TriageIO {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface TriageCommandOptions {
  cwd?: string;
  io?: TriageIO;
  /** Test seam: inject the triage runner instead of spawning a real CLI. */
  runner?: TriageRunner;
  /** Test seam: override `$EDITOR` invocation for `--interactive`. */
  editor?: (path: string) => Promise<void>;
  /**
   * Test seam: override the interactive confirmation prompt. Default reads
   * from stdin until a newline is seen; tests inject a function that
   * returns the canned answer.
   */
  confirm?: (message: string) => Promise<boolean>;
  /** Test seam: override the `now()` clock stamped on every decision / feedback. */
  now?: () => string;
}

type TriageMode = "dry-run" | "apply" | "interactive";

interface TriageRunArgs {
  mode?: TriageMode;
  source?: string;
  filterTags?: string[];
  triageAgent?: string;
  policy?: string;
  maxItems?: number;
  auditLog?: string;
  verbose?: boolean;
  quiet?: boolean;
  help?: boolean;
  /**
   * Host-agent mode (#279 / ADR-0019): emit the triage payload to stdout
   * without spawning an agent. The host (interactive) session classifies the
   * items itself, writes the decisions JSON, then finalizes via `--commit`.
   */
  emitPayload?: boolean;
  /**
   * Host-agent mode (#279 / ADR-0019): finalize a host-written decisions file.
   * Holds the path to the JSON the host session wrote. The CLI re-validates it
   * against the input item set + per-source policy and applies the status
   * transitions.
   */
  commit?: string;
}

interface TriageFeedbackArgs {
  itemId?: string;
  correct?: boolean;
  wrong?: boolean;
  reason?: string;
  help?: boolean;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntFlag(flag: string, raw: string | undefined, min: number): number {
  if (raw === undefined) throw new Error(`option ${flag} requires a value`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`option ${flag} expects an integer >= ${min}, got '${raw}'`);
  }
  return n;
}

function parseTriageRunArgs(args: string[]): TriageRunArgs {
  const out: TriageRunArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--dry-run") {
      if (out.mode) throw new Error("--dry-run / --apply / --interactive are mutually exclusive");
      out.mode = "dry-run";
      continue;
    }
    if (a === "--apply") {
      if (out.mode) throw new Error("--dry-run / --apply / --interactive are mutually exclusive");
      out.mode = "apply";
      continue;
    }
    if (a === "--interactive") {
      if (out.mode) throw new Error("--dry-run / --apply / --interactive are mutually exclusive");
      out.mode = "interactive";
      continue;
    }
    if (a === "--source") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.source = value;
      continue;
    }
    if (a === "--filter-tags") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.filterTags = splitCsv(value);
      continue;
    }
    if (a === "--triage-agent") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.triageAgent = value;
      continue;
    }
    if (a === "--policy") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.policy = value;
      continue;
    }
    if (a === "--max-items") {
      out.maxItems = parseIntFlag(a, args[++i], 1);
      continue;
    }
    if (a === "--audit-log") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.auditLog = value;
      continue;
    }
    if (a === "--emit-payload") {
      out.emitPayload = true;
      continue;
    }
    if (a === "--commit") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.commit = value;
      continue;
    }
    if (a === "--verbose" || a === "-v") {
      out.verbose = true;
      continue;
    }
    if (a === "--quiet" || a === "-q") {
      out.quiet = true;
      continue;
    }
    if (a?.startsWith("--") || a === "-h") {
      throw new Error(`unknown option: ${a}`);
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  if (out.verbose && out.quiet) {
    throw new Error("--verbose and --quiet are mutually exclusive");
  }
  return out;
}

function parseTriageFeedbackArgs(args: string[]): TriageFeedbackArgs {
  const out: TriageFeedbackArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--correct") {
      out.correct = true;
      continue;
    }
    if (a === "--wrong") {
      out.wrong = true;
      continue;
    }
    if (a === "--reason") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.reason = value;
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

function printRunHelp(log: (m: string) => void): void {
  log("Usage: radar triage [--dry-run | --apply | --interactive] [options]");
  log("       radar triage --emit-payload [--source <id>] [options]");
  log("       radar triage --commit <path>");
  log("");
  log("Classify `detected` items using the configured per-source triage policy.");
  log("");
  log("Modes (mutually exclusive; default: --dry-run):");
  log("  --dry-run            print proposed decisions to stdout (no disk writes)");
  log("  --apply              write decisions to items/<id>.yaml + transition status");
  log("  --interactive        --dry-run output → $EDITOR → confirm → apply");
  log("");
  log("Options:");
  log("  --source <id>            limit triage to a single source");
  log("  --filter-tags <a,b>      matchedKeywords allow-list (comma-separated)");
  log("  --triage-agent <id>      override policy.agent for this run");
  log("  --policy <path>          override per-source policy with a YAML file");
  log("  --max-items N            hard cap on items triaged in this run");
  log("  --audit-log <path>       append JSONL audit records of every triage call");
  log("  --emit-payload           Host-agent mode (ADR-0019): print the triage payload to");
  log("                           stdout and DO NOT spawn an agent. The interactive host");
  log("                           session classifies the items itself, writes a decisions");
  log("                           JSON, then finalizes with `radar triage --commit <path>`.");
  log("                           Requires a single source group: pass --source unless only");
  log("                           one source has detected items. Interactive/opt-in only —");
  log("                           CI/headless must use the default spawn path.");
  log("  --commit <path>          Host-agent mode (ADR-0019): validate a host-written");
  log("                           decisions JSON (under <cwd>/triage/) against the source's");
  log("                           policy + detected items and apply the status transitions.");
  log("  -v, --verbose            verbose progress output");
  log("  -q, --quiet              suppress progress output entirely");
  log("");
  log("Sources missing a `triagePolicy:` block are skipped with a warning. See");
  log("ADR-0018 for the policy schema reference.");
}

function printFeedbackHelp(log: (m: string) => void): void {
  log("Usage: radar triage feedback <item-id> --correct | --wrong [--reason <text>]");
  log("");
  log("Record human feedback on a prior triage decision (ADR-0018 §W5).");
  log("Feedback is appended to items/<id>.yaml > triage.feedback, used by");
  log("`radar triage stats` (#242) for policy tuning.");
  log("");
  log("Options:");
  log("  --correct            mark the prior triage decision as correct");
  log("  --wrong              mark the prior triage decision as wrong");
  log("  --reason <text>      free-form rationale (recommended for --wrong)");
}

function printTriageHelp(log: (m: string) => void): void {
  log("Usage: radar triage <subcommand|--apply|--dry-run|--interactive> [...]");
  log("");
  log("Subcommands:");
  log("  feedback <item-id> --correct | --wrong [--reason <text>]");
  log("  stats [--since <duration>] [--source <id>] [--json]");
  log("");
  log("Run modes (when no subcommand given):");
  log("  --dry-run            print proposed decisions");
  log("  --apply              write decisions to items/<id>.yaml");
  log("  --interactive        edit decisions in $EDITOR before applying");
  log("");
  log("Run `radar triage --help` for the full option list.");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * Load `--policy <path>` if supplied and validate it against
 * `SourceTriagePolicySchema`. Returns the parsed policy or `null` on error
 * (and reports the error via the supplied sink).
 */
async function loadPolicyOverride(
  path: string,
  error: (m: string) => void,
): Promise<SourceTriagePolicy | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    error(`triage: failed to read --policy ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    error(
      `triage: invalid YAML in --policy ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  const result = SourceTriagePolicySchema.safeParse(parsed);
  if (!result.success) {
    error(`triage: --policy ${path} validation failed`);
    for (const issue of result.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return null;
  }
  return result.data;
}

/**
 * Render a decision map as a deterministic block of stdout lines (one row
 * per decision). Used for `--dry-run` and for the buffer fed to `$EDITOR`
 * in interactive mode.
 *
 * Format (per row):
 *   <item-id> <decision> conf=<n.nn> group=<g|->  reason=<short>
 */
function formatDecisionTable(items: Item[], decisions: Map<string, TriageDecision>): string[] {
  const lines: string[] = [];
  const idWidth = Math.max(...items.map((i) => i.id.length), 2);
  lines.push(`${"ID".padEnd(idWidth)}  DECISION  CONFIDENCE  GROUP   REASON`);
  for (const item of items) {
    const d = decisions.get(item.id);
    if (!d) {
      lines.push(`${item.id.padEnd(idWidth)}  (no decision)`);
      continue;
    }
    const group = d.group ?? "-";
    const conf = d.confidence.toFixed(2);
    lines.push(
      `${item.id.padEnd(idWidth)}  ${d.decision.padEnd(8)}  ${conf.padEnd(10)}  ${group.padEnd(6)}  ${d.reason}`,
    );
  }
  return lines;
}

/**
 * Apply a triage decision map to the supplied items, returning the next
 * persisted `Item` shape (status transitioned, `triage` populated,
 * `dismissedBy` set for triage-origin dismisses).
 *
 * The function is pure: it does not write to disk. Callers (`--apply` and
 * the interactive confirm step) invoke `saveItems()` after this.
 */
function buildUpdatedItems(
  items: Item[],
  decisions: Map<string, TriageDecision>,
  triageAgent: string,
): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    const decision = decisions.get(item.id);
    if (!decision) {
      // Should never happen — triageItems guarantees decisions.size ===
      // items.length. If it does, leave the item alone and skip.
      continue;
    }
    const newStatus = statusForTriageDecision(decision.decision);
    const next: Item = {
      ...item,
      triage: decision,
      status: newStatus,
    };
    if (decision.decision === "dismiss") {
      // Record triage origin so `radar undismiss` can silently revert without
      // requiring `--force` (ADR-0018 §W6).
      const dismissedBy = `triage_${triageAgent}` as DismissedBy;
      next.dismissedBy = dismissedBy;
    }
    out.push(next);
  }
  return out;
}

/**
 * Open `$EDITOR` on a temp file pre-filled with `body`. Returns the edited
 * content. The function is best-effort: if `$EDITOR` is unset we fall back
 * to `vi`. The shape of the buffer is intentionally human-readable (the
 * `formatDecisionTable` output) but the post-edit content is NOT re-parsed
 * — interactive mode treats the editor session as a confirmation gate
 * rather than a structured editor (full structured editing is deferred to
 * a future PR).
 */
async function defaultEditor(path: string): Promise<void> {
  const editor = process.env.EDITOR ?? "vi";
  const result = spawnSync(editor, [path], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`$EDITOR exited with status ${result.status}`);
  }
}

/**
 * Read stdin synchronously-ish for the interactive confirm prompt. Falls
 * back to "n" when stdin is closed (test environments) so the operation is
 * a no-op rather than throwing.
 */
async function promptConfirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} `);
  return await new Promise<boolean>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        const answer = buf.slice(0, nl).trim().toLowerCase();
        resolve(answer === "y" || answer === "yes");
      }
    };
    const onEnd = (): void => {
      resolve(false);
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

/**
 * A source group resolved for triage: the detected items plus the policy /
 * agent that govern them. Shared by the spawn run path and the host-agent
 * `--emit-payload` path so both select / filter / group items identically.
 */
interface TriageGroup {
  sourceId: string;
  items: Item[];
  policy: SourceTriagePolicy;
  triageAgent: string;
}

type PrepareTriageGroupsResult =
  | { exitCode: number }
  | { groups: TriageGroup[]; detected: Item[]; itemsDir: string };

/**
 * Shared PRE block for the spawn run path and `--emit-payload`: load `detected`
 * items, apply `--source` / `--filter-tags` / `--max-items`, group by source,
 * resolve each group's policy (honoring `--policy` override) + triage agent
 * (honoring `--triage-agent`, validated against `AgentIdSchema`).
 *
 * Extracted so the host-agent payload path computes the exact same group /
 * policy / agent resolution the spawn path uses — keeping the two contracts
 * from drifting (the spawn agent and the host session triage the same item set
 * under the same policy).
 *
 * Returns `{ exitCode }` for the caller to propagate on error / no-op, or the
 * resolved groups plus the full `detected` set (for the decision table) and the
 * items dir.
 */
async function prepareTriageGroups(
  parsed: TriageRunArgs,
  cwd: string,
  io: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): Promise<PrepareTriageGroupsResult> {
  const { log, warn, error } = io;

  const sourcesDir = join(cwd, "sources");
  if (!(await pathExists(sourcesDir))) {
    error("triage: no sources/ directory (run `radar init` first)");
    return { exitCode: 1 };
  }
  const sources = await loadSources(sourcesDir, error);
  if (sources.length === 0) {
    log("triage: no sources defined; nothing to triage");
    return { exitCode: 0 };
  }

  let policyOverride: SourceTriagePolicy | null = null;
  if (parsed.policy) {
    policyOverride = await loadPolicyOverride(parsed.policy, error);
    if (!policyOverride) return { exitCode: 2 };
  }

  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) {
    log("triage: no items/ directory; nothing to triage");
    return { exitCode: 0 };
  }
  let allItems: Item[];
  try {
    allItems = await loadItems(itemsDir, parsed.source);
  } catch (e) {
    error(`triage: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }
  // ADR-0018 §W-B: triage only operates on `detected` items so re-running
  // `radar triage` is idempotent.
  let detected = allItems.filter((i) => i.status === "detected");
  if (parsed.filterTags && parsed.filterTags.length > 0) {
    const tags = new Set(parsed.filterTags);
    detected = detected.filter((i) => i.matchedKeywords.some((k) => tags.has(k)));
  }
  if (detected.length === 0) {
    log("triage: no detected items match the filter (nothing to do)");
    return { exitCode: 0 };
  }
  if (parsed.maxItems !== undefined && detected.length > parsed.maxItems) {
    warn(
      `triage: ${detected.length} detected item(s) exceed --max-items ${parsed.maxItems}; processing the first ${parsed.maxItems} only`,
    );
    detected = detected.slice(0, parsed.maxItems);
  }

  const sourcesById = new Map<string, Source>(sources.map((s) => [s.id, s]));
  const grouped = new Map<string, Item[]>();
  for (const item of detected) {
    const arr = grouped.get(item.sourceId);
    if (arr) arr.push(item);
    else grouped.set(item.sourceId, [item]);
  }

  const groups: TriageGroup[] = [];
  for (const [sourceId, groupItems] of grouped) {
    const source = sourcesById.get(sourceId);
    const policy = policyOverride ?? source?.triagePolicy;
    if (!policy) {
      warn(
        `triage: skipping ${groupItems.length} item(s) from source '${sourceId}' (no triagePolicy configured)`,
      );
      continue;
    }
    const triageAgent = parsed.triageAgent ?? policy.agent;
    // Validate `--triage-agent` against `AgentIdSchema` before spending an
    // agent call (or emitting a payload) — typos like `gemnini-cli` fail fast.
    const validated = AgentIdSchema.safeParse(triageAgent);
    if (!validated.success) {
      error(
        `triage: --triage-agent '${triageAgent}' is not a valid agent id (claude-code | codex-cli | gemini-cli | copilot)`,
      );
      return { exitCode: 2 };
    }
    groups.push({ sourceId, items: groupItems, policy, triageAgent });
  }

  return { groups, detected, itemsDir };
}

/**
 * Decisions-file schema for `radar triage --commit` (#279 / ADR-0019).
 *
 * The host session writes a self-describing envelope: the triage `agent` id
 * (stamped into each `TriageDecision.agent` + the `dismissedBy` origin), the
 * `sourceId` the decisions belong to (so the CLI re-resolves the matching
 * policy), and the `decisions` array — the same JSON the spawned triage agent
 * emits on stdout (see `core/triage/prompt.ts` output schema). `itemIds` /
 * `decisionsPath` from the payload's JSON fence are accepted but ignored on
 * commit (the CLI re-derives the item set from disk), so the host can echo the
 * whole payload fence back without breaking parse.
 */
const TriageDecisionsFileSchema = z.object({
  agent: z.string().min(1),
  sourceId: z.string().min(1),
  decisions: z.array(
    z.object({
      id: z.string().min(1),
      decision: TriageDecisionValueSchema,
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1),
      group: z.string().min(1).optional(),
    }),
  ),
});

/**
 * Host-agent emit path (#279 / ADR-0019): run the same group / policy / agent
 * resolution as the spawn path (`prepareTriageGroups`), then print the
 * agent-neutral triage payload to stdout instead of spawning. The host session
 * reads the payload, classifies the items itself, writes the decisions JSON,
 * and finalizes via `radar triage --commit`.
 *
 * Constrained to a SINGLE source group: triage's commit contract re-resolves
 * one source's policy, and the host writes one decisions file, so a multi-source
 * emit would need multiple files / commits. When more than one source has
 * detected items the user must narrow with `--source` (mirrors the ADR-0020
 * "one item set at a time" host-mode posture).
 */
async function runTriageEmitPayload(
  parsed: TriageRunArgs,
  cwd: string,
  io: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): Promise<number> {
  const { log, error } = io;
  const prepared = await prepareTriageGroups(parsed, cwd, io);
  if ("exitCode" in prepared) return prepared.exitCode;
  const { groups } = prepared;

  if (groups.length === 0) {
    log("triage: no items were triaged (all sources skipped)");
    return 0;
  }
  if (groups.length > 1) {
    error(
      `triage: --emit-payload requires a single source group, but ${groups.length} sources have detected items (${groups
        .map((g) => g.sourceId)
        .join(", ")}). Narrow with --source <id>.`,
    );
    return 2;
  }

  const group = groups[0];
  const triagePrompt = buildTriagePrompt({ items: group.items, policy: group.policy });
  const decisionsPath = join(cwd, "triage", `${group.sourceId}_decisions.json`);
  log(
    renderTriagePayloadBlock({
      agent: group.triageAgent,
      sourceId: group.sourceId,
      triagePrompt,
      itemIds: group.items.map((i) => i.id),
      decisionsPath,
    }),
  );
  return 0;
}

/**
 * Host-agent commit path (#279 / ADR-0019): finalize a decisions file the host
 * session wrote out-of-band. The CLI keeps owning validation + the state
 * machine (ADR-0019 finalize SSoT): it re-loads the source's `detected` items,
 * re-resolves the policy, and runs the host-written decisions through the SAME
 * `parseTriageResponse` validator the spawn path uses (hallucinated-id reject,
 * duplicate reject, confidence-threshold + digest-without-group demotion) before
 * applying `buildUpdatedItems` + `saveItems`.
 *
 * The path is constrained to `<cwd>/triage/` first (M3b enforced in code) so a
 * host misled by injected content into committing an arbitrary path is rejected
 * at the CLI boundary.
 */
async function runTriageCommit(
  parsed: TriageRunArgs,
  commitPath: string,
  cwd: string,
  options: TriageCommandOptions,
  io: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): Promise<number> {
  const { log, warn, error } = io;
  const now = options.now ?? defaultNow;

  const guard = await resolveCommitPathInside(cwd, "triage", commitPath);
  if ("error" in guard) {
    error(`triage: ${guard.error}`);
    return 2;
  }
  const resolved = guard.resolved;

  if (!(await pathExists(resolved))) {
    error(`triage: decisions file not found: ${resolved}`);
    return 1;
  }
  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (e) {
    error(`triage: failed to read decisions file: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    error(
      `triage: decisions file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  const fileResult = TriageDecisionsFileSchema.safeParse(parsedJson);
  if (!fileResult.success) {
    error("triage: decisions file does not match the expected shape:");
    for (const issue of fileResult.error.issues) {
      error(`  - ${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return 1;
  }
  const file = fileResult.data;

  // The triage agent must be a valid adapter id (it drives `dismissedBy` +
  // `triage.agent`). Reject upfront rather than persisting a bogus origin.
  const agentValid = AgentIdSchema.safeParse(file.agent);
  if (!agentValid.success) {
    error(
      `triage: decisions file agent '${file.agent}' is not a valid agent id (claude-code | codex-cli | gemini-cli | copilot)`,
    );
    return 1;
  }
  const triageAgent = file.agent;

  // Re-resolve the source's policy. `--policy` override wins (parity with the
  // run path); otherwise the per-source `triagePolicy`. The policy drives the
  // confidence-threshold demotion the CLI re-applies below, so committing
  // without a resolvable policy is rejected rather than guessed.
  let policyOverride: SourceTriagePolicy | null = null;
  if (parsed.policy) {
    policyOverride = await loadPolicyOverride(parsed.policy, error);
    if (!policyOverride) return 2;
  }
  const sourcesDir = join(cwd, "sources");
  if (!policyOverride && !(await pathExists(sourcesDir))) {
    error("triage: no sources/ directory (run `radar init` first)");
    return 1;
  }
  let policy = policyOverride;
  if (!policy) {
    const sources = await loadSources(sourcesDir, error);
    const source = sources.find((s) => s.id === file.sourceId);
    if (!source) {
      error(`triage: decisions file references unknown source '${file.sourceId}'`);
      return 1;
    }
    if (!source.triagePolicy) {
      error(
        `triage: source '${file.sourceId}' has no triagePolicy (cannot validate decisions; pass --policy <path>)`,
      );
      return 1;
    }
    policy = source.triagePolicy;
  }

  // Re-load the source's `detected` items from disk: the decisions file is NOT
  // trusted to enumerate the item set (a host misled by injected content could
  // omit or invent ids). `parseTriageResponse` then rejects hallucinated ids
  // and the coverage check fills omitted items with `unsure` — exactly the
  // spawn path's behavior.
  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) {
    error("triage: no items/ directory; nothing to commit");
    return 1;
  }
  let allItems: Item[];
  try {
    allItems = await loadItems(itemsDir, file.sourceId);
  } catch (e) {
    error(`triage: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const detected = allItems.filter((i) => i.status === "detected");
  if (detected.length === 0) {
    error(
      `triage: no detected items remain for source '${file.sourceId}' (already triaged, or wrong source?)`,
    );
    return 1;
  }

  // Re-validate through the SAME parser the spawn path runs. We feed the raw
  // decisions array as JSON so `parseTriageResponse` applies its full rule set
  // (schema, hallucinated-id reject, duplicate reject, confidence/digest
  // demotion) — keeping validation a single source of truth (ADR-0019).
  const triagedAt = now();
  let parsedResponse: ReturnType<typeof parseTriageResponse>;
  try {
    parsedResponse = parseTriageResponse(JSON.stringify(file.decisions), detected, policy);
  } catch (e) {
    const message =
      e instanceof TriageResponseParseError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    error(`triage: decisions validation failed: ${message}`);
    return 1;
  }
  for (const w of parsedResponse.warnings) warn(`triage: ${w}`);

  // Fill omitted items with an `unsure` fallback so every detected item gets a
  // decision (mirrors `triageItems`'s coverage invariant). The CLI owns the
  // transition for the whole detected set, not just the ids the host returned.
  const decisions = new Map<string, TriageDecision>();
  for (const item of detected) {
    const entry = parsedResponse.entries.get(item.id);
    if (entry === undefined) {
      warn(`triage: item '${item.id}' was not classified by the host; recording as unsure`);
      decisions.set(item.id, {
        decision: "unsure",
        confidence: 0,
        reason: "host-omitted",
        agent: triageAgent,
        triagedAt,
        feedback: [],
      });
      continue;
    }
    decisions.set(item.id, {
      decision: entry.decision,
      confidence: entry.confidence,
      reason: entry.reason,
      group: entry.group,
      agent: triageAgent,
      triagedAt,
      feedback: [],
    });
  }

  const updated = buildUpdatedItems(detected, decisions, triageAgent);
  try {
    await saveItems(itemsDir, updated);
  } catch (e) {
    error(`triage: failed to write items: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  log(`triage: committed ${updated.length} decision(s) for source '${file.sourceId}'`);
  for (const row of formatDecisionTable(detected, decisions)) log(row);
  return 0;
}

/**
 * Top-level dispatcher for `radar triage`. Routes to the feedback subcommand
 * when the first positional is `feedback`, otherwise runs the triage flow.
 */
export async function runTriage(
  args: string[],
  options: TriageCommandOptions = {},
): Promise<number> {
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));

  const [first, ...rest] = args;
  if (first === "feedback") {
    return runTriageFeedback(rest, options);
  }
  if (first === "stats") {
    return runTriageStats(rest, options, { log, warn, error });
  }
  if (first === "help") {
    printTriageHelp(log);
    return 0;
  }
  // `--help` / `-h` flow through to the run-mode parser so the user sees
  // the full option list (the `feedback` subcommand has its own help).
  // Otherwise the entire args list is the run-mode flag set.
  return runTriageRun(args, options, { log, warn, error });
}

/**
 * Implementation of `radar triage [--dry-run | --apply | --interactive]`.
 *
 * The function does the bookkeeping (parsing, source/item loading, mode
 * dispatch, status transitions) but delegates the actual classification to
 * `triageItems()` so the CLI tests can swap in `tests/helpers/triage-mock.ts`
 * via `options.runner`.
 */
async function runTriageRun(
  args: string[],
  options: TriageCommandOptions,
  io: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): Promise<number> {
  const { log, warn, error } = io;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? defaultNow;

  let parsed: TriageRunArgs;
  try {
    parsed = parseTriageRunArgs(args);
  } catch (e) {
    error(`triage: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printRunHelp(log);
    return 0;
  }

  // Host-agent commit (#279 / ADR-0019). Independent of the run modes: it takes
  // a decisions-file <path> and re-validates against disk. Handled first since
  // it must not be confused with `--dry-run` / `--apply` / `--interactive`.
  if (parsed.commit !== undefined) {
    if (parsed.mode) {
      error("triage: --commit is incompatible with --dry-run / --apply / --interactive");
      return 2;
    }
    if (parsed.emitPayload) {
      error("triage: --commit is incompatible with --emit-payload");
      return 2;
    }
    return runTriageCommit(parsed, parsed.commit, cwd, options, io);
  }

  // Host-agent emit (#279 / ADR-0019). Mutually exclusive with the apply / dry
  // / interactive run modes — it prints a payload instead of running an agent.
  if (parsed.emitPayload) {
    if (parsed.mode) {
      error("triage: --emit-payload is incompatible with --dry-run / --apply / --interactive");
      return 2;
    }
    return runTriageEmitPayload(parsed, cwd, io);
  }

  const mode: TriageMode = parsed.mode ?? "dry-run";

  // Progress reporter (#197 / ADR-0015). The triage CLI uses the spinner
  // sparingly — one phase marker before the agent call and one after — so
  // even verbose mode stays scannable. Real progress chunks (agent stdout
  // passthrough) live inside the adapter and only surface when --verbose is
  // set.
  const level: ProgressLevel = parsed.quiet ? "quiet" : parsed.verbose ? "verbose" : "normal";
  const reporter = createProgressReporter({ level });

  // Shared PRE block: load + filter + group detected items and resolve each
  // group's policy / agent (also used by `--emit-payload`).
  const prepared = await prepareTriageGroups(parsed, cwd, io);
  if ("exitCode" in prepared) return prepared.exitCode;
  const { groups, detected, itemsDir } = prepared;

  // Run triageItems() per source group. Aggregate decisions + updated items
  // across groups so a single dry-run / apply pass surfaces every decision in
  // one operation.
  const allUpdated: Item[] = [];
  const allDecisions = new Map<string, TriageDecision>();
  const allErrors: string[] = [];

  for (const { sourceId, items: groupItems, policy, triageAgent } of groups) {
    reporter.phase(
      `Triaging ${groupItems.length} item(s) from source '${sourceId}' via ${triageAgent}`,
    );

    let result: TriageResult;
    try {
      result = await triageItems(groupItems, {
        policy,
        agent: triageAgent,
        cwd,
        runner: options.runner,
        auditLog: parsed.auditLog,
        now,
      });
    } catch (e) {
      error(`triage: ${sourceId}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }

    for (const [id, dec] of result.decisions) {
      allDecisions.set(id, dec);
    }
    allErrors.push(...result.errors);
    const updated = buildUpdatedItems(groupItems, result.decisions, triageAgent);
    allUpdated.push(...updated);
  }

  if (allErrors.length > 0) {
    for (const e of allErrors) warn(`triage: ${e}`);
  }

  if (allDecisions.size === 0) {
    log("triage: no items were triaged (all sources skipped)");
    return 0;
  }

  // Render the decision table. Used by every mode.
  const rows = formatDecisionTable(detected, allDecisions);

  if (mode === "dry-run") {
    log("triage: dry-run — no changes written");
    for (const row of rows) log(row);
    return 0;
  }

  if (mode === "interactive") {
    // Write the table to a temp file, open $EDITOR, then ask for
    // confirmation. The edited content is NOT re-parsed — interactive mode
    // is currently a confirmation gate, not a structured editor.
    const dir = await mkdtemp(join(tmpdir(), "radar-triage-"));
    const tmp = join(dir, "decisions.txt");
    const header = [
      "# radar triage --interactive",
      "# Review the proposed decisions below. Save & close the editor to",
      "# return to the confirmation prompt. (The edited content is not yet",
      "# parsed back — this is a confirmation gate.)",
      "",
    ];
    await writeFile(tmp, [...header, ...rows, ""].join("\n"), "utf8");
    const editor = options.editor ?? defaultEditor;
    try {
      await editor(tmp);
    } catch (e) {
      error(`triage: editor failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    const confirm = options.confirm ?? promptConfirm;
    const confirmed = await confirm("Apply these decisions? [y/N]");
    if (!confirmed) {
      log("triage: aborted by user");
      return 0;
    }
  }

  // --apply (or --interactive after confirm). Persist to disk.
  try {
    await saveItems(itemsDir, allUpdated);
  } catch (e) {
    error(`triage: failed to write items: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  log(`triage: applied ${allUpdated.length} decision(s)`);
  for (const row of rows) log(row);
  return 0;
}

/**
 * Implementation of `radar triage feedback <item-id> --correct | --wrong`.
 *
 * Per ADR-0018 §W5 / post-review comment, feedback writes overwrite the
 * existing entry rather than appending — this CLI exposes the "human's
 * current verdict on the prior triage decision" rather than a multi-reviewer
 * audit log (the schema's `feedback: []` array supports the latter, we just
 * don't expose it through the CLI yet).
 */
async function runTriageFeedback(args: string[], options: TriageCommandOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const error = options.io?.error ?? ((m: string) => console.error(m));
  const now = options.now ?? defaultNow;

  let parsed: TriageFeedbackArgs;
  try {
    parsed = parseTriageFeedbackArgs(args);
  } catch (e) {
    error(`triage feedback: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printFeedbackHelp(log);
    return 0;
  }
  if (!parsed.itemId) {
    error("triage feedback: missing <item-id>");
    printFeedbackHelp(error);
    return 2;
  }
  if (parsed.correct && parsed.wrong) {
    error("triage feedback: --correct and --wrong are mutually exclusive");
    return 2;
  }
  if (!parsed.correct && !parsed.wrong) {
    error("triage feedback: one of --correct | --wrong is required");
    return 2;
  }

  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) {
    error(`triage feedback: items/ not found (run \`radar init\`)`);
    return 1;
  }

  let items: Item[];
  try {
    items = await loadItems(itemsDir);
  } catch (e) {
    error(`triage feedback: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const item = items.find((i) => i.id === parsed.itemId);
  if (!item) {
    error(`triage feedback: item '${parsed.itemId}' not found under items/`);
    return 1;
  }
  if (!item.triage) {
    error(`triage feedback: item '${item.id}' has no prior triage decision to give feedback on`);
    return 1;
  }

  // Overwrite-semantic: replace the existing feedback array with a single
  // entry carrying the human's current verdict. The append-only schema
  // shape is preserved (it stays an array) so a future multi-reviewer CLI
  // can extend without changing the on-disk schema.
  const feedback = [
    {
      correct: parsed.correct === true,
      reason: parsed.reason,
      feedbackAt: now(),
    },
  ];
  const updated: Item = {
    ...item,
    triage: {
      ...item.triage,
      feedback,
    },
  };
  try {
    await saveItems(itemsDir, [updated]);
  } catch (e) {
    error(`triage feedback: failed to write item: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const verdict = parsed.correct ? "correct" : "wrong";
  log(`triage feedback: items/${item.sourceId}/${item.id}.yaml feedback -> ${verdict}`);
  return 0;
}

// ---------------------------------------------------------------------------
// `radar triage stats` (#242) — aggregate triage decisions + human feedback
// to surface precision / recall drift and policy-tuning hints.
//
// The command is read-only: it walks `items/<source>/<id>.yaml`, groups items
// per source, counts decisions, derives override directions from the feedback
// array (for research / digest / dismiss) or current status (for unsure), and
// renders one block per source. `--json` returns the same data as a structured
// payload for downstream scripts.
// ---------------------------------------------------------------------------

interface TriageStatsArgs {
  since?: string;
  source?: string;
  json?: boolean;
  help?: boolean;
}

interface PerSourceStats {
  source: string;
  total: number;
  byDecision: Record<"research" | "digest" | "dismiss" | "unsure", number>;
  digestGroups: number;
  humanOverrides: {
    triagedDismissToResearch: number; // false negative (recall miss)
    triagedResearchToDismiss: number; // false positive (precision miss)
    triagedUnsureToResearch: number;
    triagedUnsureToDismiss: number;
  };
  agent: string | null; // dominant agent across triaged items
  policyPath: string | null; // sources/<id>.yaml or null
  policyLastEditedDaysAgo: number | null;
  suggestions: string[];
}

interface StatsOutput {
  sinceDays: number | null;
  generatedAt: string;
  perSource: PerSourceStats[];
}

function parseTriageStatsArgs(args: string[]): TriageStatsArgs {
  const out: TriageStatsArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--since") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.since = value;
      continue;
    }
    if (a === "--source") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      out.source = value;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a?.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

function printStatsHelp(log: (m: string) => void): void {
  log("Usage: radar triage stats [--since <duration>] [--source <id>] [--json]");
  log("");
  log("Aggregate triage decisions and human feedback (ADR-0018 §W5, #242).");
  log("Use after running `radar triage --apply` for some weeks; the output");
  log("highlights precision / recall drift and suggests `triagePolicy.rules:`");
  log("tweaks. See docs/user-guide.md `policy tuning workflow` for the");
  log("recommended monthly loop.");
  log("");
  log("Options:");
  log("  --since <duration>   only count items triaged within the cutoff (e.g. 30d, 24h)");
  log("  --source <id>        limit stats to a single source (default: all sources)");
  log("  --json               emit machine-readable JSON instead of the text report");
}

/**
 * Parse `Nd | Nh | Nm | Ns` into a `Date` cutoff. Returns `null` when the
 * shape doesn't match — callers translate that into a CLI error. Mirrors
 * `parseSinceCutoff` in items.ts so the two `--since` flags accept the same
 * syntax.
 */
function parseSinceCutoffForStats(value: string, now: Date = new Date()): Date | null {
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

function sinceCutoffToDays(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2];
  if (unit === "d") return n;
  if (unit === "h") return Math.round((n / 24) * 10) / 10;
  if (unit === "m") return Math.round((n / 1440) * 10) / 10;
  return Math.round((n / 86_400) * 10) / 10;
}

/**
 * Derive the human-override breakdown for a single source's triaged items.
 *
 * Two pathways feed the same counters:
 *
 * 1. `triage.feedback[].correct === false` (research / digest / dismiss
 *    decisions) — an explicit signal the human disagreed. Each decision class
 *    only flips one direction (research → dismiss, dismiss → research), so a
 *    single boolean is enough.
 * 2. `status` mutation downstream of `triaged_unsure` — the schema has no
 *    "unsure direction" feedback field; instead we infer from where the item
 *    landed (`researched` / `reviewed` → research; `dismissed` → dismiss).
 *    This is best-effort: items still sitting in `triaged_unsure` are
 *    excluded.
 *
 * The function only walks items whose `triage.decision` is set — items
 * without a triage record (legacy or pending) are silently skipped.
 */
function computeHumanOverrides(items: Item[]): PerSourceStats["humanOverrides"] {
  let triagedDismissToResearch = 0;
  let triagedResearchToDismiss = 0;
  let triagedUnsureToResearch = 0;
  let triagedUnsureToDismiss = 0;

  for (const item of items) {
    const triage = item.triage;
    if (!triage) continue;
    const latestFeedback = triage.feedback[triage.feedback.length - 1];
    if (triage.decision === "research" || triage.decision === "digest") {
      if (latestFeedback?.correct === false) {
        triagedResearchToDismiss += 1;
      }
    } else if (triage.decision === "dismiss") {
      if (latestFeedback?.correct === false) {
        triagedDismissToResearch += 1;
      }
    } else if (triage.decision === "unsure") {
      // Two reads: explicit feedback (with --correct flagging an outcome) and
      // status-derived inference. Status wins because the schema doesn't have
      // a per-direction field for unsure.
      if (item.status === "researched" || item.status === "reviewed") {
        triagedUnsureToResearch += 1;
      } else if (item.status === "dismissed") {
        triagedUnsureToDismiss += 1;
      } else if (item.status === "triaged_research") {
        triagedUnsureToResearch += 1;
      }
    }
  }

  return {
    triagedDismissToResearch,
    triagedResearchToDismiss,
    triagedUnsureToResearch,
    triagedUnsureToDismiss,
  };
}

/**
 * Heuristic policy-tuning hints (ADR-0018 §W5, #242).
 *
 * Triggered by 3 thresholds:
 *
 * - 3+ false negatives → recommend reviewing dismiss criteria, prefixing
 *   common `matchedKeywords` from the offending items so the user knows
 *   *which* dismissed items the agent missed.
 * - 3+ false positives → recommend tightening research criteria with the
 *   same keyword extraction pattern (different message).
 * - 5+ unsure decisions → recommend lowering `confidenceThreshold` or
 *   spelling out unsure cases in `rules:`.
 *
 * Below the thresholds we stay silent — surfacing 1-event "trends" would
 * train users to ignore the section.
 */
function buildSuggestions(items: Item[], overrides: PerSourceStats["humanOverrides"]): string[] {
  const suggestions: string[] = [];

  const falseNegativeItems = items.filter(
    (i) =>
      i.triage?.decision === "dismiss" &&
      i.triage.feedback[i.triage.feedback.length - 1]?.correct === false,
  );
  const falsePositiveItems = items.filter(
    (i) =>
      (i.triage?.decision === "research" || i.triage?.decision === "digest") &&
      i.triage.feedback[i.triage.feedback.length - 1]?.correct === false,
  );

  if (falseNegativeItems.length >= 3) {
    const hint = extractTopKeywordHint(falseNegativeItems);
    suggestions.push(
      `${falseNegativeItems.length} false negatives — review dismiss criteria${hint ? ` for ${hint} topics` : ""}`,
    );
  }
  if (falsePositiveItems.length >= 3) {
    const hint = extractTopKeywordHint(falsePositiveItems);
    suggestions.push(
      `${falsePositiveItems.length} false positives — tighten research criteria${hint ? ` for ${hint} topics` : ""}`,
    );
  }
  const unsureCount =
    overrides.triagedUnsureToResearch +
    overrides.triagedUnsureToDismiss +
    items.filter((i) => i.triage?.decision === "unsure" && i.status === "triaged_unsure").length;
  if (unsureCount >= 5) {
    suggestions.push(
      `${unsureCount} unsure decisions — lower confidenceThreshold or add "判断困難なら ..." clause to rules`,
    );
  }
  return suggestions;
}

/**
 * Extract the top 1-3 most common `matchedKeywords` (or title-derived words
 * when keywords are absent) from a set of items, joined as ` / `. Used to
 * give the suggestion a concrete "what to look at" hook without dumping
 * every keyword in the source.
 */
function extractTopKeywordHint(items: Item[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.matchedKeywords.length > 0) {
      for (const kw of item.matchedKeywords) {
        counts.set(kw, (counts.get(kw) ?? 0) + 1);
      }
    } else {
      // Fall back to title tokens (best-effort). We only consider tokens of
      // length >= 4 to skip prepositions / particles.
      for (const token of item.title.split(/[\s/,.;:!?()[\]【】「」、。]+/)) {
        if (token.length >= 4) counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) return "";
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, 3).map(([k]) => k);
  return top.join(" / ");
}

/**
 * Aggregate stats per source group. Pure: takes items + a per-source policy
 * lookup, returns a sorted array of `PerSourceStats`. The CLI layer wires
 * disk I/O around it.
 */
function aggregatePerSource(
  items: Item[],
  policyMeta: Map<string, { agent: string; path: string; lastEditedDaysAgo: number | null }>,
  sinceCutoff: Date | null,
): PerSourceStats[] {
  const grouped = new Map<string, Item[]>();
  for (const item of items) {
    if (!item.triage) continue;
    if (sinceCutoff) {
      const triagedAt = new Date(item.triage.triagedAt);
      if (Number.isNaN(triagedAt.getTime()) || triagedAt < sinceCutoff) continue;
    }
    const arr = grouped.get(item.sourceId);
    if (arr) arr.push(item);
    else grouped.set(item.sourceId, [item]);
  }

  const out: PerSourceStats[] = [];
  for (const [sourceId, group] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const byDecision = { research: 0, digest: 0, dismiss: 0, unsure: 0 };
    const groups = new Set<string>();
    const agentCounts = new Map<string, number>();
    for (const item of group) {
      const triage = item.triage;
      if (!triage) continue;
      byDecision[triage.decision] += 1;
      if (triage.decision === "digest" && triage.group) {
        groups.add(triage.group);
      }
      agentCounts.set(triage.agent, (agentCounts.get(triage.agent) ?? 0) + 1);
    }
    const overrides = computeHumanOverrides(group);
    const suggestions = buildSuggestions(group, overrides);
    const dominantAgent =
      [...agentCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
      null;
    const meta = policyMeta.get(sourceId);
    out.push({
      source: sourceId,
      total: group.length,
      byDecision,
      digestGroups: groups.size,
      humanOverrides: overrides,
      agent: dominantAgent,
      policyPath: meta?.path ?? null,
      policyLastEditedDaysAgo: meta?.lastEditedDaysAgo ?? null,
      suggestions,
    });
  }
  return out;
}

function formatPercent(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function renderStatsBlock(stat: PerSourceStats, sinceDays: number | null): string[] {
  const lines: string[] = [];
  const heading = sinceDays
    ? `[${stat.source}] triage stats (last ${sinceDays} day${sinceDays === 1 ? "" : "s"})`
    : `[${stat.source}] triage stats`;
  lines.push(heading);
  lines.push(`  total triaged:    ${stat.total}`);
  lines.push(
    `  research:          ${stat.byDecision.research} (${formatPercent(stat.byDecision.research, stat.total)})`,
  );
  const digestSuffix =
    stat.byDecision.digest > 0
      ? ` — ${stat.digestGroups} group${stat.digestGroups === 1 ? "" : "s"}`
      : "";
  lines.push(
    `  digest:            ${stat.byDecision.digest} (${formatPercent(stat.byDecision.digest, stat.total)})${digestSuffix}`,
  );
  lines.push(
    `  dismiss:           ${stat.byDecision.dismiss} (${formatPercent(stat.byDecision.dismiss, stat.total)})`,
  );
  lines.push(
    `  unsure:             ${stat.byDecision.unsure} (${formatPercent(stat.byDecision.unsure, stat.total)})`,
  );

  // Human overrides section — derived precision / recall from the feedback
  // arrays. The "miss" percentages are computed against the relevant decision
  // count (recall miss = false negatives / dismiss total, precision miss =
  // false positives / (research + digest) total) so a high override count on
  // a small decision class doesn't masquerade as a global problem.
  const o = stat.humanOverrides;
  const totalOverrides =
    o.triagedDismissToResearch +
    o.triagedResearchToDismiss +
    o.triagedUnsureToResearch +
    o.triagedUnsureToDismiss;
  if (totalOverrides > 0) {
    lines.push("");
    lines.push("  human overrides:");
    if (o.triagedDismissToResearch > 0) {
      const recallMiss = formatPercent(o.triagedDismissToResearch, stat.byDecision.dismiss);
      lines.push(
        `    triaged_dismiss → research:    ${pad(String(o.triagedDismissToResearch), 2)} (false negatives, ${recallMiss} recall miss)`,
      );
    }
    if (o.triagedResearchToDismiss > 0) {
      const denom = stat.byDecision.research + stat.byDecision.digest;
      const precisionMiss = formatPercent(o.triagedResearchToDismiss, denom);
      lines.push(
        `    triaged_research → dismiss:    ${pad(String(o.triagedResearchToDismiss), 2)} (false positives, ${precisionMiss} precision miss)`,
      );
    }
    if (o.triagedUnsureToResearch > 0) {
      lines.push(`    triaged_unsure → research:     ${pad(String(o.triagedUnsureToResearch), 2)}`);
    }
    if (o.triagedUnsureToDismiss > 0) {
      lines.push(`    triaged_unsure → dismiss:      ${pad(String(o.triagedUnsureToDismiss), 2)}`);
    }
  }

  lines.push("");
  if (stat.agent) lines.push(`  agent: ${stat.agent}`);
  if (stat.policyPath) {
    const ageSuffix =
      stat.policyLastEditedDaysAgo !== null
        ? ` (last edited ${stat.policyLastEditedDaysAgo} day${stat.policyLastEditedDaysAgo === 1 ? "" : "s"} ago)`
        : "";
    lines.push(`  policy: ${stat.policyPath}${ageSuffix}`);
  }

  if (stat.suggestions.length > 0) {
    lines.push("");
    lines.push("  Suggestions:");
    for (const s of stat.suggestions) {
      lines.push(`    - ${s}`);
    }
  }
  return lines;
}

/**
 * Implementation of `radar triage stats`. Walks `items/` (optionally filtered
 * by `--source` / `--since`), groups by source, and renders the per-source
 * decision breakdown + override summary + heuristic suggestions.
 *
 * Pure failures (no items / no triaged items) return exit 0 with an
 * informational message so cron-wrapped invocations don't trip alarms.
 */
async function runTriageStats(
  args: string[],
  options: TriageCommandOptions,
  io: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): Promise<number> {
  const { log, error } = io;
  const cwd = options.cwd ?? process.cwd();
  const nowFn = options.now ?? defaultNow;
  const now = new Date(nowFn());

  let parsed: TriageStatsArgs;
  try {
    parsed = parseTriageStatsArgs(args);
  } catch (e) {
    error(`triage stats: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printStatsHelp(log);
    return 0;
  }

  let sinceCutoff: Date | null = null;
  if (parsed.since) {
    sinceCutoff = parseSinceCutoffForStats(parsed.since, now);
    if (!sinceCutoff) {
      error(`triage stats: invalid --since '${parsed.since}' (expected Ns | Nm | Nh | Nd)`);
      return 2;
    }
  }

  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) {
    if (parsed.json) {
      log(
        JSON.stringify(
          {
            sinceDays: sinceCutoffToDays(parsed.since),
            generatedAt: now.toISOString(),
            perSource: [],
          },
          null,
          2,
        ),
      );
    } else {
      log("triage stats: no items/ directory (run `radar init` first)");
    }
    return 0;
  }

  let items: Item[];
  try {
    items = await loadItems(itemsDir, parsed.source);
  } catch (e) {
    error(`triage stats: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Build a per-source policy meta lookup so we can show `policy: sources/<id>.yaml
  // (last edited N days ago)`. Best-effort: missing files become null entries
  // and the rendering side omits the line.
  const sourcesDir = join(cwd, "sources");
  const policyMeta = new Map<
    string,
    { agent: string; path: string; lastEditedDaysAgo: number | null }
  >();
  if (await pathExists(sourcesDir)) {
    const sources = await loadSources(sourcesDir, () => {
      /* swallow load errors — stats is read-only and shouldn't fail loudly */
    });
    for (const source of sources) {
      if (!source.triagePolicy) continue;
      const relPath = `sources/${source.id}.yaml`;
      const abs = join(sourcesDir, `${source.id}.yaml`);
      let daysAgo: number | null = null;
      try {
        const st = await stat(abs);
        const diffMs = now.getTime() - st.mtime.getTime();
        daysAgo = Math.max(0, Math.floor(diffMs / 86_400_000));
      } catch {
        // File missing or stat failed — leave daysAgo null.
      }
      policyMeta.set(source.id, {
        agent: source.triagePolicy.agent,
        path: relPath,
        lastEditedDaysAgo: daysAgo,
      });
    }
  }

  const perSource = aggregatePerSource(items, policyMeta, sinceCutoff);
  const sinceDays = sinceCutoffToDays(parsed.since);

  if (parsed.json) {
    const payload: StatsOutput = {
      sinceDays,
      generatedAt: now.toISOString(),
      perSource,
    };
    log(JSON.stringify(payload, null, 2));
    return 0;
  }

  if (perSource.length === 0) {
    log("triage stats: no triaged items match the filter (nothing to report)");
    return 0;
  }

  let first = true;
  for (const block of perSource) {
    if (!first) log("");
    first = false;
    for (const line of renderStatsBlock(block, sinceDays)) {
      log(line);
    }
  }
  return 0;
}

// Exported for unit tests (`tests/cli/triage-stats*.test.ts`) so the
// aggregation / suggestion heuristics can be exercised without the surrounding
// CLI plumbing. Not part of the public API.
export const __test__ = {
  aggregatePerSource,
  buildSuggestions,
  computeHumanOverrides,
  extractTopKeywordHint,
  parseSinceCutoffForStats,
  renderStatsBlock,
};

export const triageCommand: Command = {
  name: "triage",
  summary: "LLM-based triage of detected items (ADR-0018)",
  run: (args) => runTriage(args),
};
