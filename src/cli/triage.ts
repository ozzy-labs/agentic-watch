import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadItems, saveItems } from "../core/items.js";
import { createProgressReporter, type ProgressLevel } from "../core/progress.js";
import { statusForTriageDecision } from "../core/transitions.js";
import { type TriageResult, type TriageRunner, triageItems } from "../core/triage/index.js";
import { loadSources } from "../core/watcher.js";
import type { DismissedBy, Item, TriageDecision } from "../schemas/item.js";
import { AgentIdSchema } from "../schemas/research.js";
import type { Source, SourceTriagePolicy } from "../schemas/source.js";
import { SourceTriagePolicySchema } from "../schemas/source.js";
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
  const mode: TriageMode = parsed.mode ?? "dry-run";

  // Progress reporter (#197 / ADR-0015). The triage CLI uses the spinner
  // sparingly — one phase marker before the agent call and one after — so
  // even verbose mode stays scannable. Real progress chunks (agent stdout
  // passthrough) live inside the adapter and only surface when --verbose is
  // set.
  const level: ProgressLevel = parsed.quiet ? "quiet" : parsed.verbose ? "verbose" : "normal";
  const reporter = createProgressReporter({ level });

  // 1. Load sources to discover per-source policies (and to map item.sourceId
  //    → policy when items span sources).
  const sourcesDir = join(cwd, "sources");
  if (!(await pathExists(sourcesDir))) {
    error("triage: no sources/ directory (run `radar init` first)");
    return 1;
  }
  const sources = await loadSources(sourcesDir, error);
  if (sources.length === 0) {
    log("triage: no sources defined; nothing to triage");
    return 0;
  }

  // 2. Optional `--policy` override applies to every source in the run. This
  //    is documented as a 1-shot override — useful for trying a new policy
  //    against an existing source without editing the YAML.
  let policyOverride: SourceTriagePolicy | null = null;
  if (parsed.policy) {
    policyOverride = await loadPolicyOverride(parsed.policy, error);
    if (!policyOverride) return 2;
  }

  // 3. Load detected items, narrowing by `--source` and `--filter-tags`.
  const itemsDir = join(cwd, "items");
  if (!(await pathExists(itemsDir))) {
    log("triage: no items/ directory; nothing to triage");
    return 0;
  }
  let allItems: Item[];
  try {
    allItems = await loadItems(itemsDir, parsed.source);
  } catch (e) {
    error(`triage: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // ADR-0018 §W-B: triage only operates on `detected` items. items already
  // triaged / researched / dismissed are excluded so re-running `radar
  // triage` is idempotent.
  let detected = allItems.filter((i) => i.status === "detected");
  if (parsed.filterTags && parsed.filterTags.length > 0) {
    const tags = new Set(parsed.filterTags);
    detected = detected.filter((i) => i.matchedKeywords.some((k) => tags.has(k)));
  }
  if (detected.length === 0) {
    log("triage: no detected items match the filter (nothing to do)");
    return 0;
  }
  if (parsed.maxItems !== undefined && detected.length > parsed.maxItems) {
    warn(
      `triage: ${detected.length} detected item(s) exceed --max-items ${parsed.maxItems}; processing the first ${parsed.maxItems} only`,
    );
    detected = detected.slice(0, parsed.maxItems);
  }

  // 4. Group by sourceId so each source uses its own policy. Items from
  //    sources without a policy (and no `--policy` override) are skipped
  //    with a warning — the CLI never invents a policy on the user's behalf.
  const sourcesById = new Map<string, Source>(sources.map((s) => [s.id, s]));
  const grouped = new Map<string, Item[]>();
  for (const item of detected) {
    const arr = grouped.get(item.sourceId);
    if (arr) arr.push(item);
    else grouped.set(item.sourceId, [item]);
  }

  // 5. Run triageItems() per source group. Aggregate decisions + updated
  //    items across groups so a single dry-run / apply pass surfaces every
  //    decision in one operation.
  const allUpdated: Item[] = [];
  const allDecisions = new Map<string, TriageDecision>();
  const allErrors: string[] = [];

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
    // agent call — typos like `gemnini-cli` should fail fast.
    const validated = AgentIdSchema.safeParse(triageAgent);
    if (!validated.success) {
      error(
        `triage: --triage-agent '${triageAgent}' is not a valid agent id (claude-code | codex-cli | gemini-cli | copilot)`,
      );
      return 2;
    }

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

export const triageCommand: Command = {
  name: "triage",
  summary: "LLM-based triage of detected items (ADR-0018)",
  run: (args) => runTriage(args),
};
