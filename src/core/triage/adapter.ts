import { spawn } from "node:child_process";
import type { AgentId } from "../../schemas/research.js";

/**
 * Triage channel adapter (ADR-0018 §W4 / §W-E-2).
 *
 * Separated from `src/agents/AgentAdapter` (research / review / update) on
 * purpose: the triage prompt shape is different (JSON response, no file
 * writes), and folding it into the existing interface would either pollute
 * the contract or force per-adapter `triage()` no-ops. ADR-0018 §W4
 * recommends "別 channel" so this module owns the triage spawn.
 *
 * Defaults shell out to the same agent CLIs (`claude`, `codex`, `gemini`,
 * `copilot`). Tests inject `TriageRunner` instead of spawning a real CLI.
 *
 * Rate-limit policy (W-E-2):
 *
 * The runner classifies its return value into one of `ok` / `rate-limited`
 * / `error` so the orchestrator can apply per-class retry policy:
 *
 * - `ok`: agent returned 0 exit, stdout has the JSON array — bubble up.
 * - `rate-limited`: agent stderr / stdout looks like 429 / 503 — exponential
 *   backoff (1s, 2s, 4s, ... cap 60s, max 3 retries). After exhaustion,
 *   the orchestrator demotes affected items to `triaged_unsure` with reason
 *   `"rate-limited"`.
 * - `error`: any other non-zero exit — bubble up to the orchestrator which
 *   applies the global fallback path (all items → `triaged_unsure`,
 *   `fallback: true`).
 *
 * The 429 / 503 classifier is intentionally permissive (substring match on
 * the error text). Cheap-model CLIs format rate-limit errors in
 * idiosyncratic ways (HTTP status code in JSON envelope, plain "Too Many
 * Requests" in stderr, etc.) and a precise regex would miss variants
 * silently — false positives here just trigger a backoff retry, which is
 * harmless.
 */

export interface TriageRunInput {
  agent: AgentId;
  prompt: string;
  cwd: string;
}

export type TriageRunStatus = "ok" | "rate-limited" | "error";

export interface TriageRunResult {
  status: TriageRunStatus;
  /** Raw agent stdout (used for JSON extraction on `ok`, debug on others). */
  stdout: string;
  /** Raw agent stderr (used for error reporting + rate-limit classification). */
  stderr: string;
  /** Exit code from the spawned CLI; `0` on `ok`, non-zero otherwise. */
  exitCode: number;
}

/**
 * Function shape for the agent-CLI runner. The default implementation
 * shells out to the real `claude` / `codex` / `gemini` / `copilot` CLIs.
 * Tests inject a fake so end-to-end coverage does not require an
 * authenticated CLI on PATH.
 */
export type TriageRunner = (input: TriageRunInput) => Promise<TriageRunResult>;

/**
 * Cheap heuristic that flags a CLI failure as rate-limited.
 *
 * Exported so the orchestrator (`index.ts`) and tests can rely on the same
 * classifier. Matches on substrings rather than exact codes because the
 * cheap-model CLIs format rate-limit errors inconsistently — they all
 * include one of the listed needles somewhere in stdout / stderr.
 */
export function looksLikeRateLimit(text: string): boolean {
  const haystack = text.toLowerCase();
  return [
    "429",
    "rate limit",
    "rate-limit",
    "rate_limited",
    "too many requests",
    "503",
    "service unavailable",
    "quota exceeded",
    "resource_exhausted",
    "resource exhausted",
  ].some((needle) => haystack.includes(needle));
}

/**
 * Per-agent CLI invocation matrix. The triage channel reuses the same
 * binaries as the research channel (claude-code → `claude`, etc.) but with
 * triage-specific flags:
 *
 * - All adapters pass a short, fixed `STDIN_INVOCATION` on argv and stream the
 *   full triage request (policy + per-item blocks + JSON schema) on stdin.
 *   The request scales with item count — a backfilled source can produce a
 *   135KB+ prompt — and Linux caps a *single* argv string at `MAX_ARG_STRLEN`
 *   (128KB) independently of the larger `ARG_MAX` total, so an argv-borne
 *   prompt dies with `spawn E2BIG` on large sources (#270). stdin has no such
 *   limit. This mirrors how the research / review / update adapters in
 *   `src/agents/*.ts` already feed their bulk payload (they all
 *   `child.stdin.write(...)`); the CLIs surface piped stdin to the model.
 * - We launch each CLI in the equivalent "non-interactive, full-permission"
 *   mode that the research adapter uses, so the user does not need to
 *   re-authorize tools. See the individual `src/agents/*.ts` files for the
 *   rationale on each flag set.
 *
 * For the cheap-model channel intent (gemini-2.5-flash-lite,
 * claude-haiku-4-5), the model selection is left to the agent CLI's own
 * config — ADR-0018 §W4 explicitly leaves "which model the triage channel
 * routes to" as adapter-internal, not schema-modeled. Users who want a
 * specific cheap model set it via `gemini config set model …` (or
 * equivalent) on their workstation.
 */
/**
 * Fixed argv prompt handed to every triage CLI. It carries no per-item data
 * (so its size never approaches `MAX_ARG_STRLEN`) and simply directs the
 * agent to the real request streamed on stdin. The detailed instructions —
 * trust-boundary rules, output schema, per-item rules — live in the stdin
 * payload built by `buildTriagePrompt`, so this stays a thin pointer.
 */
export const STDIN_INVOCATION = [
  "A triage request is provided on standard input. Read it in full and follow",
  "its instructions exactly: classify every item it lists and respond with the",
  "single JSON array it specifies — no prose, no Markdown fences, nothing else.",
].join("\n");

/**
 * Build the spawn command + argv for a triage agent. The prompt is NOT an
 * argument (it goes on stdin — see {@link runTriageAgentCli} and the
 * module-level note on `MAX_ARG_STRLEN` / #270); argv carries only the fixed
 * {@link STDIN_INVOCATION} plus the per-CLI non-interactive flags. Exported so
 * tests can assert the prompt never lands on argv regardless of item count.
 */
export function buildSpawnArgs(agent: AgentId): { command: string; args: string[] } {
  switch (agent) {
    case "claude-code":
      return {
        command: "claude",
        args: [
          "-p",
          STDIN_INVOCATION,
          "--output-format",
          "text",
          "--permission-mode",
          "bypassPermissions",
        ],
      };
    case "gemini-cli":
      return {
        command: "gemini",
        args: ["-p", STDIN_INVOCATION, "-y", "--skip-trust", "--output-format", "text"],
      };
    case "codex-cli":
      return {
        command: "codex",
        args: ["exec", "--dangerously-bypass-approvals-and-sandbox", STDIN_INVOCATION],
      };
    case "copilot":
      return {
        command: "copilot",
        args: ["-p", STDIN_INVOCATION, "--allow-all-paths", "--allow-all-tools"],
      };
  }
}

/**
 * Default runner: spawn the per-agent CLI and capture stdout / stderr.
 *
 * Returns `{ status: "ok" }` only on exit code 0. Non-zero exit triggers
 * the rate-limit classifier; if the heuristic matches, we surface
 * `rate-limited` so the orchestrator's exponential backoff can engage,
 * otherwise we surface `error` so the global fallback path runs.
 *
 * `ENOENT` (CLI not on PATH) propagates as `{ status: "error" }` rather
 * than a thrown exception so the orchestrator's fallback path handles it
 * the same way as any other CLI failure — triage shouldn't kill the
 * workflow just because the user hasn't installed an optional CLI.
 */
export async function runTriageAgentCli(input: TriageRunInput): Promise<TriageRunResult> {
  const { command, args } = buildSpawnArgs(input.agent);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ status: "error", stdout: "", stderr: `spawn failed: ${message}`, exitCode: -1 });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      // ENOENT, EACCES, etc. — surface as `error` so the orchestrator's
      // global fallback runs. Storing the formatted message in stderr lets
      // the audit log capture what went wrong.
      resolve({
        status: "error",
        stdout,
        stderr: `${stderr}\nspawn error: ${err.message}`.trim(),
        exitCode: -1,
      });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode === 0) {
        resolve({ status: "ok", stdout, stderr, exitCode });
        return;
      }
      const combined = `${stderr}\n${stdout}`;
      const status: TriageRunStatus = looksLikeRateLimit(combined) ? "rate-limited" : "error";
      resolve({ status, stdout, stderr, exitCode });
    });
    // Swallow EPIPE: a missing / early-exiting CLI tears down stdin before we
    // finish writing the (potentially 100KB+) prompt. The failure is already
    // surfaced via the `error` / `close` handlers above, so a stray stdin
    // write error must not become an unhandled exception.
    child.stdin?.on("error", () => {});
    // Stream the full triage request on stdin (#270). argv only carries the
    // fixed STDIN_INVOCATION, so the per-item payload — which can exceed the
    // 128KB MAX_ARG_STRLEN limit — never rides on the command line.
    child.stdin?.write(input.prompt);
    child.stdin?.end();
  });
}
