import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Item, TriageDecision } from "../../schemas/item.js";
import type { SourceTriagePolicy } from "../../schemas/source.js";
import { runTriageAgentCli, type TriageRunner, type TriageRunResult } from "./adapter.js";
import { type BuildTriagePromptOptions, buildTriagePrompt } from "./prompt.js";
import { parseTriageResponse, TriageResponseParseError } from "./response.js";

/**
 * Public API for the triage channel (ADR-0018 PR-2).
 *
 * `triageItems(items, options)` runs every supplied `detected` item through
 * the configured agent CLI and returns a `Map<itemId, TriageDecision>`
 * suitable for the PR-3 CLI to merge into `items/<id>.yaml > triage:`.
 *
 * The contract is:
 *
 * - **Every input item gets a decision.** Hallucinated ids, agent omission,
 *   parse errors, and total fallbacks all resolve to `decision: "unsure"`
 *   entries. The caller can rely on `result.decisions.size === items.length`
 *   for the common case (we keep the invariant even when the agent omits
 *   ids — the orchestrator fills the gap).
 * - **`fallback: true` only when the agent itself failed end-to-end.** A
 *   per-item demotion (low confidence, digest without group) is NOT a
 *   fallback; only "agent CLI down, all items unsure" sets the flag.
 * - **Soft-fail on rate limit (W-E-2).** Persistent 429 / 503 after
 *   exponential backoff demotes affected items to `unsure` with reason
 *   `"rate-limited"` rather than crashing the orchestrator. The workflow
 *   continues so subsequent sources / commands run.
 * - **Audit log (W-E-3).** When `auditLog` is supplied, the full request +
 *   raw response + parsed decisions are appended as JSONL — one line per
 *   triage call. Default off, so `radar triage` with no flag has the same
 *   storage footprint as before.
 */

export interface TriageItemsOptions {
  /** Per-source policy block. Drives prompt rules + confidence threshold. */
  policy: SourceTriagePolicy;
  /**
   * Agent identifier to use for the triage call. Almost always `policy.agent`;
   * exposed as a separate field so the CLI can override via
   * `--agent <id>` for ad-hoc retries without mutating the source YAML.
   */
  agent: string;
  /** Working directory for the spawned CLI. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Optional runner injection. Production code uses the default
   * `runTriageAgentCli`; tests inject a fake so the suite does not depend
   * on `claude` / `gemini` / `codex` / `copilot` being on PATH.
   */
  runner?: TriageRunner;
  /**
   * When set, raw request / response / parsed decisions are appended to
   * this path as JSONL (one record per `triageItems()` call). Off by
   * default — see ADR-0018 §W-E-3 for the storage-cost rationale.
   */
  auditLog?: string;
  /** Override the ISO timestamp stamped on every decision. For test determinism. */
  now?: () => string;
  /**
   * Maximum retry attempts for rate-limited (429 / 503) responses. Default
   * 3 — matches ADR-0018 §W-E-2's recommendation. Each retry waits
   * `min(initialDelayMs * 2^(attempt-1), maxDelayMs)`.
   */
  maxRetries?: number;
  /** Initial backoff delay (ms). Default 1000. */
  initialDelayMs?: number;
  /** Backoff cap (ms). Default 60_000. */
  maxDelayMs?: number;
  /** Sleep override (ms → Promise). Defaults to `setTimeout`. Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TriageResult {
  /**
   * One `TriageDecision` per input item, keyed by `item.id`. Includes items
   * the agent omitted entirely (those carry `decision: "unsure"` + reason
   * `"agent-omitted"`). Size equals `items.length` post-call.
   */
  decisions: Map<string, TriageDecision>;
  /**
   * `true` when the full-fallback path was hit (agent down, total parse
   * failure, all retries exhausted with no usable entries). Per-item
   * demotions (low confidence / hallucinated id) do NOT flip this flag.
   */
  fallback: boolean;
  /**
   * Free-form warnings for the operator. Mirrors the response parser's
   * `warnings[]` plus orchestrator-level notes (retry exhaustion, audit
   * log write failure, etc.).
   */
  errors: string[];
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * Build a fallback `TriageDecision` for an item the agent did not classify
 * (omission, hallucinated id rejected, parse failure, full fallback, etc.).
 * Centralised so every fallback path stamps the same shape.
 */
function buildFallbackDecision(agent: string, reason: string, triagedAt: string): TriageDecision {
  return {
    decision: "unsure",
    confidence: 0,
    reason,
    agent,
    triagedAt,
    feedback: [],
  };
}

/**
 * Append a JSONL audit record. Failures here are non-fatal: an unwritable
 * audit log path should not kill the triage workflow. We surface the
 * failure as a `result.errors[]` entry instead so the operator can see it
 * in the CLI output.
 */
async function appendAuditLog(
  path: string,
  record: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `audit log write failed (${path}): ${message}`;
  }
}

/**
 * Invoke the agent runner with exponential-backoff retry on `rate-limited`
 * results. Returns the final `TriageRunResult` (which may itself be
 * `rate-limited` if every retry hit the cap) plus the number of attempts
 * made (for the audit log).
 */
async function runWithRetry(
  runner: TriageRunner,
  agent: string,
  prompt: string,
  cwd: string,
  maxRetries: number,
  initialDelayMs: number,
  maxDelayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ result: TriageRunResult; attempts: number }> {
  let attempt = 0;
  let result: TriageRunResult = {
    status: "error",
    stdout: "",
    stderr: "no attempts",
    exitCode: -1,
  };
  while (attempt <= maxRetries) {
    attempt++;
    result = await runner({ agent: agent as AgentArgument, prompt, cwd });
    if (result.status !== "rate-limited" || attempt > maxRetries) {
      break;
    }
    const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
    await sleep(delay);
  }
  return { result, attempts: attempt };
}

/**
 * `AgentId` runtime cast for the spawn matrix. `TriageItemsOptions.agent`
 * is typed as `string` so the CLI can pass a custom override; the spawn
 * matrix only handles the four `AgentId` values, so an unknown agent will
 * fall through to the runner's default error path (or the test-injected
 * runner can accept any string).
 */
type AgentArgument = Parameters<TriageRunner>[0]["agent"];

/**
 * Triage the supplied items via the configured agent CLI.
 *
 * The function is the single entry point for PR-3's `radar triage` CLI and
 * for any future caller (workflow generator, integration tests). It returns
 * a `TriageResult` with one decision per input item plus a `fallback` flag
 * and warning list.
 *
 * Empty input is handled as a no-op (no spawn) and returns
 * `{ decisions: empty, fallback: false, errors: [] }` so callers can pass
 * the result of a `filter()` chain without guarding for length.
 */
export async function triageItems(
  items: Item[],
  options: TriageItemsOptions,
): Promise<TriageResult> {
  const errors: string[] = [];
  const decisions = new Map<string, TriageDecision>();
  const now = options.now ?? defaultNow;
  const triagedAt = now();
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? runTriageAgentCli;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  if (items.length === 0) {
    return { decisions, fallback: false, errors };
  }

  const promptOptions: BuildTriagePromptOptions = { items, policy: options.policy };
  const prompt = buildTriagePrompt(promptOptions);

  let runResult: TriageRunResult;
  let attempts = 0;
  try {
    const retryOutcome = await runWithRetry(
      runner,
      options.agent,
      prompt,
      cwd,
      maxRetries,
      initialDelayMs,
      maxDelayMs,
      sleep,
    );
    runResult = retryOutcome.result;
    attempts = retryOutcome.attempts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runResult = {
      status: "error",
      stdout: "",
      stderr: `runner threw: ${message}`,
      exitCode: -1,
    };
    attempts = 1;
  }

  // --- Failure paths ---------------------------------------------------

  // Rate-limited after exhausting retries → soft-fail with per-item reason.
  if (runResult.status === "rate-limited") {
    errors.push(
      `triage agent persistently rate-limited after ${attempts} attempt(s); falling back to unsure (rate-limited)`,
    );
    for (const item of items) {
      decisions.set(item.id, buildFallbackDecision(options.agent, "rate-limited", triagedAt));
    }
    if (options.auditLog) {
      const auditErr = await appendAuditLog(options.auditLog, {
        ts: triagedAt,
        agent: options.agent,
        attempts,
        status: "rate-limited",
        itemIds: items.map((i) => i.id),
        request: prompt,
        response: runResult.stdout,
        stderr: runResult.stderr,
        exitCode: runResult.exitCode,
        fallback: true,
        rateLimited: true,
      });
      if (auditErr) errors.push(auditErr);
    }
    return { decisions, fallback: true, errors };
  }

  // Hard error (CLI down, non-zero exit unrelated to rate-limit, runner threw)
  if (runResult.status === "error") {
    const tail = (runResult.stderr || runResult.stdout || "(no output)").trim();
    errors.push(`triage agent CLI failed (exit ${runResult.exitCode}): ${tail}`);
    for (const item of items) {
      decisions.set(item.id, buildFallbackDecision(options.agent, "agent CLI failure", triagedAt));
    }
    if (options.auditLog) {
      const auditErr = await appendAuditLog(options.auditLog, {
        ts: triagedAt,
        agent: options.agent,
        attempts,
        status: "error",
        itemIds: items.map((i) => i.id),
        request: prompt,
        response: runResult.stdout,
        stderr: runResult.stderr,
        exitCode: runResult.exitCode,
        fallback: true,
      });
      if (auditErr) errors.push(auditErr);
    }
    return { decisions, fallback: true, errors };
  }

  // --- Happy / partial path ---------------------------------------------

  try {
    const parsed = parseTriageResponse(runResult.stdout, items, options.policy);
    errors.push(...parsed.warnings);
    for (const item of items) {
      const entry = parsed.entries.get(item.id);
      if (entry === undefined) {
        decisions.set(item.id, buildFallbackDecision(options.agent, "agent-omitted", triagedAt));
        continue;
      }
      decisions.set(item.id, {
        decision: entry.decision,
        confidence: entry.confidence,
        reason: entry.reason,
        group: entry.group,
        agent: options.agent,
        triagedAt,
        feedback: [],
      });
    }

    if (options.auditLog) {
      const auditErr = await appendAuditLog(options.auditLog, {
        ts: triagedAt,
        agent: options.agent,
        attempts,
        status: "ok",
        itemIds: items.map((i) => i.id),
        request: prompt,
        response: runResult.stdout,
        stderr: runResult.stderr,
        exitCode: runResult.exitCode,
        decisions: Object.fromEntries(
          items
            .map((item) => [item.id, decisions.get(item.id)] as const)
            .filter((pair): pair is [string, TriageDecision] => pair[1] !== undefined),
        ),
        fallback: false,
      });
      if (auditErr) errors.push(auditErr);
    }
    return { decisions, fallback: false, errors };
  } catch (err) {
    // Total parse failure → all-unsure fallback (still fills every item id).
    const message =
      err instanceof TriageResponseParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    errors.push(`triage response parse failed: ${message}`);
    for (const item of items) {
      decisions.set(
        item.id,
        buildFallbackDecision(options.agent, "response parse failure", triagedAt),
      );
    }
    if (options.auditLog) {
      const auditErr = await appendAuditLog(options.auditLog, {
        ts: triagedAt,
        agent: options.agent,
        attempts,
        status: "parse-error",
        itemIds: items.map((i) => i.id),
        request: prompt,
        response: runResult.stdout,
        stderr: runResult.stderr,
        exitCode: runResult.exitCode,
        fallback: true,
        parseError: message,
      });
      if (auditErr) errors.push(auditErr);
    }
    return { decisions, fallback: true, errors };
  }
}

export {
  looksLikeRateLimit,
  runTriageAgentCli,
  type TriageRunInput,
  type TriageRunner,
  type TriageRunResult,
  type TriageRunStatus,
} from "./adapter.js";
export type { BuildTriagePromptOptions } from "./prompt.js";
// Re-export internal modules so PR-3 (CLI) can import them without reaching
// into deeper paths. Keeping the public surface narrow: only the orchestrator
// API, the prompt builder, the response parser, and the adapter types.
export { buildTriagePrompt } from "./prompt.js";
export {
  type AgentEntry,
  type ParseTriageResponseResult,
  parseTriageResponse,
  TriageResponseParseError,
  type ValidatedTriageEntry,
} from "./response.js";
