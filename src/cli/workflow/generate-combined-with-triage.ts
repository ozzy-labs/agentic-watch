import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESEARCH_BATCH_DEFAULT_MAX_ITEMS } from "../research.js";
import type { SupportedAgent, WorkflowIO } from "./generate-watch.js";
import { SUPPORTED_AGENTS } from "./generate-watch.js";

/**
 * `radar workflow generate combined-with-triage` (ADR-0018 §W5 / #241).
 *
 * Extends the `combined` generator with the LLM triage layer. The emitted
 * workflow chains 5 steps in one job:
 *
 *   watch run -> triage --apply -> research --batch (status=triaged_research)
 *     -> research --digest per triage-group -> review --batch (status=researched)
 *
 * Three distinct agents can be wired (triage / research / review) so the
 * cheap-model channel handles triage while heavier models do the LoC-heavy
 * research and the cross-agent review. The job-level `env:` block exposes
 * every selected agent's API key once so each step inherits without
 * per-step duplication (ADR-0014 D5 — API key auth only, never OAuth).
 *
 * A trailing `if: always()` notify step counts the `triaged_unsure` queue
 * depth and (optionally) POSTs it to a Slack webhook so the human-review
 * backlog cannot grow unnoticed. The notify step degrades silently when
 * no webhook is configured.
 */

/** Default watch cron — 06:00 UTC daily, matching the #241 example. */
const DEFAULT_WATCH_CRON = "0 6 * * *";

/**
 * Output modes for the final pipeline step (#258).
 *
 * - `pr` (default): emit a `peter-evans/create-pull-request@v6` step so a
 *   human reviews the bot output before it lands on the default branch.
 * - `direct-commit`: commit & push straight to the default branch (no PR
 *   gate), dropping `pull-requests: write` from `permissions:`. Mirrors the
 *   commit&push step the `watch` / `combined` generators already emit.
 */
export const OUTPUT_MODES = ["pr", "direct-commit"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

/** Default output path under `.github/workflows/`. */
const DEFAULT_OUTPUT = join(".github", "workflows", "feedradar-daily.yaml");

/**
 * Per-agent `env:` entries (single line each, no surrounding `env:` header).
 *
 * Used by `buildEnvBlock` to assemble a deduped job-level `env:` body that
 * exposes every required secret across the three agent roles. Each line is
 * 10-space indented so it sits under `      env:` (8 spaces, then 2-space
 * map child indentation) when concatenated into the template.
 *
 * `claude-code` / `codex-cli` / `gemini-cli` each declare their API key.
 * Every agent also gets `GITHUB_TOKEN` so the `github-releases` adapter
 * lifts to the 5000 req/h ceiling; the watch step is the same one used in
 * the `combined` generator, so the contract there carries over.
 *
 * `copilot` rides `secrets.GITHUB_TOKEN` natively (its CLI authenticates
 * via the workflow's GH token), so it contributes no additional secret
 * beyond the shared `GITHUB_TOKEN` line everybody gets.
 */
const AGENT_ENV_LINES: Record<SupportedAgent, string[]> = {
  "claude-code": ["      ANTHROPIC_API_KEY: $" + "{{ secrets.ANTHROPIC_API_KEY }}"],
  "codex-cli": ["      OPENAI_API_KEY: $" + "{{ secrets.OPENAI_API_KEY }}"],
  "gemini-cli": ["      GEMINI_API_KEY: $" + "{{ secrets.GEMINI_API_KEY }}"],
  copilot: [],
};

/** Always-present line: every step benefits from a higher GH rate limit. */
const SHARED_GITHUB_TOKEN_LINE = "      GITHUB_TOKEN: $" + "{{ secrets.GITHUB_TOKEN }}";

/**
 * Per-agent human-readable secret names surfaced after a successful
 * generation. Mirrors `generate-combined.ts` so the experience is
 * consistent across both generators.
 */
const AGENT_SECRET_NAMES: Record<SupportedAgent, string[]> = {
  "claude-code": ["ANTHROPIC_API_KEY"],
  "codex-cli": ["OPENAI_API_KEY"],
  "gemini-cli": ["GEMINI_API_KEY"],
  copilot: [],
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveTemplatesRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "templates");
}

/**
 * Validate a 5-field POSIX cron expression. Same grammar check as
 * `generate-combined.ts` / `generate-watch.ts`. Range bounds (e.g. month
 * 1-12) are NOT enforced here; GitHub Actions rejects out-of-range
 * expressions on workflow load.
 */
export function isValidCron(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  const tokenPattern = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/;
  for (const field of fields) {
    if (field.length === 0) return false;
    const tokens = field.split(",");
    for (const token of tokens) {
      if (token.length === 0) return false;
      if (!tokenPattern.test(token)) return false;
    }
  }
  return true;
}

/**
 * Validate that the requested `--output` path lands under
 * `.github/workflows/`. Mirrors `isSafeWorkflowPath` in `generate-watch.ts`
 * — kept inline here so the two generators don't accidentally drift on
 * the safety contract.
 */
export function isSafeWorkflowPath(outputPath: string, cwd: string): boolean {
  if (isAbsolute(outputPath)) {
    const allowedDir = resolve(cwd, ".github", "workflows");
    const resolved = resolve(outputPath);
    const rel = relative(allowedDir, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    return /\.(ya?ml)$/i.test(resolved);
  }
  const normalized = normalize(outputPath);
  if (normalized.split(/[\\/]/).includes("..")) return false;
  const required = `${join(".github", "workflows")}/`;
  const unixified = normalized.replace(/\\/g, "/");
  if (!unixified.startsWith(required.replace(/\\/g, "/"))) return false;
  return /\.(ya?ml)$/i.test(unixified);
}

/**
 * Validate `--max-items` as a positive integer (mirrors
 * `parseMaxItems` in `src/cli/research.ts`).
 */
export function isValidMaxItems(raw: string): boolean {
  if (!/^[0-9]+$/.test(raw)) return false;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0;
}

/**
 * Validate `--slack-webhook` shape. Required form: `secrets.<NAME>` (no
 * leading `${{`, no trailing `}}`). The generator wraps the name into a
 * proper GitHub Actions expression at render time so the user does not
 * have to spell it out (and so we cannot accidentally double-wrap).
 *
 * Exported for unit testing.
 */
export function isValidSlackWebhookRef(raw: string): boolean {
  return /^secrets\.[A-Z_][A-Z0-9_]*$/i.test(raw);
}

/**
 * Build the deduped job-level `env:` body from the chosen triage /
 * research / review agents. Lines are already 6-space indented (so they
 * sit at `      env:` -> `        KEY: value` once the template inserts
 * them at column 0 with `{{envBlock}}`).
 *
 * Order is deterministic (sorted) so generated workflows diff stably
 * across regenerations. `GITHUB_TOKEN` is always last because shared
 * lines come after agent-specific ones.
 */
export function buildEnvBlock(
  triageAgent: SupportedAgent,
  researchAgent: SupportedAgent,
  reviewAgent: SupportedAgent,
): string {
  const lines = new Set<string>();
  for (const agent of [triageAgent, researchAgent, reviewAgent]) {
    for (const line of AGENT_ENV_LINES[agent]) {
      lines.add(line);
    }
  }
  lines.add(SHARED_GITHUB_TOKEN_LINE);
  return [...lines].sort().join("\n");
}

/**
 * Convert a `--slack-webhook secrets.<NAME>` ref into the GitHub Actions
 * expression literal the template needs. Returns an empty string when no
 * webhook was supplied so the `[ -n "..." ]` guard in the rendered
 * notify step short-circuits cleanly.
 */
export function buildSlackWebhookExpr(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return '""';
  const trimmed = raw.trim();
  // `secrets.X` -> `${{ secrets.X }}` (full Actions expression literal).
  // biome-ignore lint/style/useTemplate: GitHub Actions expression literal — collapsing into a single template literal would re-trigger noTemplateCurlyInString
  return "$" + `{{ ${trimmed} }}`;
}

/**
 * Build the top-level `permissions:` block for the given output mode.
 *
 * - `pr` needs both `contents: write` (to create the branch/commit) and
 *   `pull-requests: write` (so `peter-evans/create-pull-request` can open
 *   the PR).
 * - `direct-commit` pushes straight to the default branch, so it only needs
 *   `contents: write`; emitting `pull-requests: write` would be an unused —
 *   and misleading — grant (#258).
 *
 * Exported for unit testing.
 */
export function buildPermissionsBlock(outputMode: OutputMode): string {
  if (outputMode === "direct-commit") {
    return ["permissions:", "  contents: write"].join("\n");
  }
  return ["permissions:", "  contents: write", "  pull-requests: write"].join("\n");
}

/**
 * Build the final pipeline step for the given output mode.
 *
 * - `pr`: a `peter-evans/create-pull-request@v6` step that stages
 *   `items/ state/ research/` into a single PR per cron tick so a human can
 *   review the auto-generated content before it lands on main
 *   (ADR-0014 §X5 / ADR-0018 §W5).
 * - `direct-commit`: a commit & push step modeled on the `watch` / `combined`
 *   generators — commit only when something changed, then push with a
 *   three-attempt `git pull --rebase --autostash` retry loop. No PR gate, so
 *   the comment warns against a PR-required branch protection on the default
 *   branch (#258).
 *
 * Both blocks are emitted with the same 6-space step indentation as the
 * surrounding steps in the template (the placeholder sits at column 0 where a
 * `- name:` step would normally start). Exported for unit testing.
 */
export function buildFinalStep(outputMode: OutputMode): string {
  if (outputMode === "direct-commit") {
    return [
      "      - name: Commit and push research output with retry",
      "        # direct-commit output mode (#258): push straight to the default",
      "        # branch instead of opening a PR. Commit only when items/ state/",
      "        # research/ actually changed, then retry the push up to 3 times with",
      "        # `git pull --rebase --autostash` between attempts (ADR-0014 D4),",
      "        # mirroring the watch / combined generators.",
      "        #",
      "        # NB: this mode pushes without a human review gate, so do NOT put a",
      "        # PR-required branch protection rule on the default branch — the bot",
      "        # commit would be rejected and every run would fail.",
      "        run: |",
      "          set -euo pipefail",
      '          git config user.name "feedradar-bot"',
      '          git config user.email "feedradar-bot@users.noreply.github.com"',
      "          git add items/ state/ research/",
      "          if git diff --cached --quiet; then",
      '            echo "nothing staged; exiting cleanly"',
      "            exit 0",
      "          fi",
      '          git commit -m "chore(feedradar): daily watch + triage + research $(date -u +%Y-%m-%d)"',
      "          for attempt in 1 2 3; do",
      // The `${...}` tokens below are bash parameter expansions in the
      // generated YAML, not JS template placeholders, so they are assembled
      // by concatenation to keep biome's noTemplateCurlyInString quiet
      // (same convention as the `${{ ... }}` Actions expressions above).
      '            if git push origin "$' + '{GITHUB_REF_NAME}"; then',
      '              echo "push succeeded on attempt $' + '{attempt}"',
      "              exit 0",
      "            fi",
      '            echo "push failed (attempt $' + '{attempt}/3), rebasing..."',
      '            git pull --rebase --autostash origin "$' + '{GITHUB_REF_NAME}"',
      "          done",
      '          echo "push failed after 3 attempts" >&2',
      "          exit 1",
    ].join("\n");
  }
  return [
    "      - name: Create PR with research output",
    "        # `peter-evans/create-pull-request@v6` stages items/ state/ research/",
    "        # into a single PR per cron tick. Human reviews the PR before",
    "        # research/ lands on main, giving an explicit gate on auto-generated",
    "        # content (ADR-0014 §X5 / ADR-0018 §W5).",
    "        uses: peter-evans/create-pull-request@v6",
    "        with:",
    '          commit-message: "chore(feedradar): daily watch + triage + research"',
    "          # peter-evans/create-pull-request does not run shell on these",
    "          # fields, so `$(date ...)` would land literally in the PR title.",
    "          # Use the `github.run_id` expression to keep titles unique per run.",
    '          title: "feedradar: daily triage + research (run $' + '{{ github.run_id }})"',
    "          body: |",
    "            Automated feedradar pipeline output. Review the research/ Markdown",
    "            before merging — generated content is untrusted (ADR-0009).",
    "          branch: feedradar/daily",
    "          base: $" + "{{ github.ref_name }}",
    "          delete-branch: true",
    "          add-paths: |",
    "            items/",
    "            state/",
    "            research/",
  ].join("\n");
}

/**
 * Render the bundled template by substituting `{{watchCron}}` /
 * `{{maxItems}}` / `{{triageAgent}}` / `{{researchAgent}}` /
 * `{{reviewAgent}}` / `{{envBlock}}` / `{{slackWebhookExpr}}` /
 * `{{permissionsBlock}}` / `{{finalStep}}`.
 */
export function renderCombinedWithTriageTemplate(
  template: string,
  values: {
    watchCron: string;
    maxItems: number;
    triageAgent: SupportedAgent;
    researchAgent: SupportedAgent;
    reviewAgent: SupportedAgent;
    envBlock: string;
    slackWebhookExpr: string;
    permissionsBlock: string;
    finalStep: string;
  },
): string {
  return template
    .replaceAll("{{watchCron}}", values.watchCron)
    .replaceAll("{{maxItems}}", String(values.maxItems))
    .replaceAll("{{triageAgent}}", values.triageAgent)
    .replaceAll("{{researchAgent}}", values.researchAgent)
    .replaceAll("{{reviewAgent}}", values.reviewAgent)
    .replaceAll("{{envBlock}}", values.envBlock)
    .replaceAll("{{slackWebhookExpr}}", values.slackWebhookExpr)
    .replaceAll("{{permissionsBlock}}", values.permissionsBlock)
    .replaceAll("{{finalStep}}", values.finalStep);
}

export interface GenerateCombinedWithTriageOptions {
  cwd: string;
  watchCron: string;
  output: string;
  triageAgent: SupportedAgent;
  researchAgent: SupportedAgent;
  reviewAgent: SupportedAgent;
  maxItems: number;
  /** `secrets.<NAME>` ref, or undefined when the notify step should no-op. */
  slackWebhook?: string;
  /** Final-step output mode (#258). Defaults to `pr`. */
  outputMode: OutputMode;
  force: boolean;
  templatesRoot?: string;
  io?: WorkflowIO;
}

export interface GenerateCombinedWithTriageResult {
  outputPath: string;
  requiredSecrets: string[];
}

/**
 * Core implementation of `radar workflow generate combined-with-triage`.
 *
 * Validates inputs, reads the bundled template, substitutes placeholders,
 * and writes the result. The completion stdout enumerates every secret the
 * user must register (across all three agent roles plus the optional
 * Slack webhook) so they do not have to grep the YAML.
 */
export async function generateCombinedWithTriage(
  options: GenerateCombinedWithTriageOptions,
): Promise<GenerateCombinedWithTriageResult> {
  const {
    cwd,
    watchCron,
    output,
    triageAgent,
    researchAgent,
    reviewAgent,
    maxItems,
    outputMode,
    force,
  } = options;
  const log = options.io?.log ?? ((m: string) => console.log(m));
  const warn = options.io?.warn ?? ((m: string) => console.warn(m));

  if (!isValidCron(watchCron)) {
    throw new Error(
      `invalid --watch-cron expression '${watchCron}' (expected 5-field POSIX cron, e.g. "0 6 * * *")`,
    );
  }
  if (!isSafeWorkflowPath(output, cwd)) {
    throw new Error(
      `invalid --output '${output}' (must be a relative path under .github/workflows/ ending in .yaml or .yml)`,
    );
  }
  if (!Number.isInteger(maxItems) || maxItems <= 0) {
    throw new Error(`invalid --max-items '${maxItems}' (must be a positive integer)`);
  }
  if (options.slackWebhook !== undefined && !isValidSlackWebhookRef(options.slackWebhook)) {
    throw new Error(
      `invalid --slack-webhook '${options.slackWebhook}' (expected 'secrets.<NAME>', e.g. 'secrets.SLACK_WEBHOOK')`,
    );
  }
  if (!(OUTPUT_MODES as readonly string[]).includes(outputMode)) {
    throw new Error(
      `invalid --output-mode '${outputMode}' (expected one of: ${OUTPUT_MODES.join(" | ")})`,
    );
  }

  const templatesRoot = options.templatesRoot ?? (await resolveTemplatesRoot());
  const templatePath = join(templatesRoot, "workflows", "combined-with-triage.template.yaml.tmpl");
  if (!(await pathExists(templatePath))) {
    throw new Error(`bundled template not found: ${templatePath}`);
  }
  const template = await readFile(templatePath, "utf8");

  const envBlock = buildEnvBlock(triageAgent, researchAgent, reviewAgent);
  const slackWebhookExpr = buildSlackWebhookExpr(options.slackWebhook);
  const permissionsBlock = buildPermissionsBlock(outputMode);
  const finalStep = buildFinalStep(outputMode);

  const rendered = renderCombinedWithTriageTemplate(template, {
    watchCron,
    maxItems,
    triageAgent,
    researchAgent,
    reviewAgent,
    envBlock,
    slackWebhookExpr,
    permissionsBlock,
    finalStep,
  });

  const destAbs = isAbsolute(output) ? output : join(cwd, output);
  const destRel = isAbsolute(output) ? relative(cwd, output) : output;

  if ((await pathExists(destAbs)) && !force) {
    throw new Error(`output file already exists: ${destRel} (use --force to overwrite)`);
  }
  if ((await pathExists(destAbs)) && force) {
    warn(`workflow generate combined-with-triage: overwriting existing file ${destRel}`);
  }

  await mkdir(dirname(destAbs), { recursive: true });
  await writeFile(destAbs, rendered, "utf8");

  // Deduped secret list across all three agent roles + optional Slack.
  const secrets = new Set<string>();
  for (const agent of [triageAgent, researchAgent, reviewAgent]) {
    for (const s of AGENT_SECRET_NAMES[agent]) secrets.add(s);
  }
  if (options.slackWebhook !== undefined) {
    // strip the `secrets.` prefix when surfacing to the user.
    secrets.add(options.slackWebhook.replace(/^secrets\./, ""));
  }
  const sortedSecrets = [...secrets].sort();

  log(`workflow generate combined-with-triage: wrote ${destRel}`);
  log(`  watch-cron:     ${watchCron}`);
  log(`  triage-agent:   ${triageAgent}`);
  log(`  research-agent: ${researchAgent}`);
  log(`  review-agent:   ${reviewAgent}`);
  log(`  max-items:      ${maxItems}`);
  log(`  output-mode:    ${outputMode}`);
  log(`  slack-webhook:  ${options.slackWebhook ?? "(none — notify step no-ops)"}`);
  log("");
  log("Required GitHub Actions secrets (Settings → Secrets and variables → Actions):");
  if (sortedSecrets.length === 0) {
    log("  (none — every selected agent rides the auto-provisioned GITHUB_TOKEN)");
  } else {
    for (const s of sortedSecrets) {
      log(`  ${s}`);
    }
  }
  log("  GITHUB_TOKEN (auto-provisioned, no setup needed)");
  warn(
    "workflow generate combined-with-triage: the --max-items cap is also enforced by `radar research --batch`; editing the YAML alone will not raise it",
  );

  return { outputPath: destRel, requiredSecrets: sortedSecrets };
}

interface ParsedFlags {
  watchCron: string;
  output: string;
  triageAgent: SupportedAgent;
  researchAgent: SupportedAgent;
  reviewAgent: SupportedAgent;
  maxItems: number;
  slackWebhook?: string;
  outputMode: OutputMode;
  force: boolean;
  help: boolean;
}

/**
 * Parse `workflow generate combined-with-triage` flags.
 *
 * Throws on missing values, unknown flags, unsupported agent choices, and
 * malformed numeric / slack-webhook input so the caller can surface
 * validation errors before any IO happens.
 */
export function parseGenerateCombinedWithTriageArgs(args: string[]): ParsedFlags {
  let watchCron = DEFAULT_WATCH_CRON;
  let output = DEFAULT_OUTPUT;
  let triageAgent: SupportedAgent = "gemini-cli";
  let researchAgent: SupportedAgent = "claude-code";
  let reviewAgent: SupportedAgent = "codex-cli";
  let maxItems = RESEARCH_BATCH_DEFAULT_MAX_ITEMS;
  let slackWebhook: string | undefined;
  let outputMode: OutputMode = "pr";
  let force = false;
  let help = false;

  function parseAgentFlag(flag: string, value: string | undefined): SupportedAgent {
    if (value === undefined) throw new Error(`option ${flag} requires a value`);
    if (!(SUPPORTED_AGENTS as readonly string[]).includes(value)) {
      throw new Error(
        `option ${flag} expects one of: ${SUPPORTED_AGENTS.join(" | ")}, got '${value}'`,
      );
    }
    return value as SupportedAgent;
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      help = true;
      continue;
    }
    if (a === "--watch-cron") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      watchCron = value;
      continue;
    }
    if (a === "--output") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      output = value;
      continue;
    }
    if (a === "--triage-agent") {
      triageAgent = parseAgentFlag(a, args[++i]);
      continue;
    }
    if (a === "--research-agent") {
      researchAgent = parseAgentFlag(a, args[++i]);
      continue;
    }
    if (a === "--review-agent") {
      reviewAgent = parseAgentFlag(a, args[++i]);
      continue;
    }
    if (a === "--max-items") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      if (!isValidMaxItems(value)) {
        throw new Error(`option --max-items expects a positive integer, got '${value}'`);
      }
      maxItems = Number.parseInt(value, 10);
      continue;
    }
    if (a === "--slack-webhook") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      if (!isValidSlackWebhookRef(value)) {
        throw new Error(`option --slack-webhook expects 'secrets.<NAME>', got '${value}'`);
      }
      slackWebhook = value;
      continue;
    }
    if (a === "--output-mode") {
      const value = args[++i];
      if (value === undefined) throw new Error(`option ${a} requires a value`);
      if (!(OUTPUT_MODES as readonly string[]).includes(value)) {
        throw new Error(
          `option --output-mode expects one of: ${OUTPUT_MODES.join(" | ")}, got '${value}'`,
        );
      }
      outputMode = value as OutputMode;
      continue;
    }
    if (a === "--force" || a === "-f") {
      force = true;
      continue;
    }
    if (a?.startsWith("--") || a?.startsWith("-")) {
      throw new Error(`unknown option: ${a}`);
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }

  return {
    watchCron,
    output,
    triageAgent,
    researchAgent,
    reviewAgent,
    maxItems,
    slackWebhook,
    outputMode,
    force,
    help,
  };
}

export function printGenerateCombinedWithTriageHelp(log: (m: string) => void): void {
  log("Usage: radar workflow generate combined-with-triage [options]");
  log("");
  log("Generates a GitHub Actions workflow that chains `radar watch run` ->");
  log("`radar triage --apply` -> `radar research --batch --status triaged_research` ->");
  log("per-group `radar research --digest` -> `radar review --batch` in one job");
  log("(ADR-0018 §W5).");
  log("");
  log("Options:");
  log(`  --watch-cron <expression>  5-field cron expression (default: "${DEFAULT_WATCH_CRON}")`);
  log("  --output <path>            Output file under .github/workflows/");
  log(`                             (default: ${DEFAULT_OUTPUT})`);
  log(
    "  --triage-agent <name>      claude-code | codex-cli | gemini-cli | copilot (default: gemini-cli)",
  );
  log(
    "  --research-agent <name>    claude-code | codex-cli | gemini-cli | copilot (default: claude-code)",
  );
  log(
    "  --review-agent <name>      claude-code | codex-cli | gemini-cli | copilot (default: codex-cli)",
  );
  log(
    `  --max-items N              Hard cap on research --batch per run (default: ${RESEARCH_BATCH_DEFAULT_MAX_ITEMS})`,
  );
  log("  --slack-webhook <ref>      Secret reference (e.g. secrets.SLACK_WEBHOOK) for the");
  log("                             triaged_unsure-queue alert (optional)");
  log("  --output-mode <mode>       pr | direct-commit (default: pr). 'pr' opens a");
  log("                             review PR; 'direct-commit' commits & pushes straight");
  log("                             to the default branch (drops pull-requests: write)");
  log("  --force, -f                Overwrite existing output file");
  log("");
  log("Required secrets (Settings → Secrets and variables → Actions):");
  log("  ANTHROPIC_API_KEY  when any role uses --agent claude-code");
  log("  OPENAI_API_KEY     when any role uses --agent codex-cli");
  log("  GEMINI_API_KEY     when any role uses --agent gemini-cli (default for triage)");
  log("  GITHUB_TOKEN       auto-provisioned (no manual setup needed)");
}

/**
 * Entry point invoked by `runWorkflow` when the user types
 * `radar workflow generate combined-with-triage`.
 */
export async function runGenerateCombinedWithTriage(
  args: string[],
  io: WorkflowIO = {},
  cwd: string = process.cwd(),
): Promise<number> {
  const log = io.log ?? ((m: string) => console.log(m));
  const error = io.error ?? ((m: string) => console.error(m));

  let parsed: ParsedFlags;
  try {
    parsed = parseGenerateCombinedWithTriageArgs(args);
  } catch (e) {
    error(`workflow generate combined-with-triage: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.help) {
    printGenerateCombinedWithTriageHelp(log);
    return 0;
  }

  try {
    await generateCombinedWithTriage({
      cwd,
      watchCron: parsed.watchCron,
      output: parsed.output,
      triageAgent: parsed.triageAgent,
      researchAgent: parsed.researchAgent,
      reviewAgent: parsed.reviewAgent,
      maxItems: parsed.maxItems,
      slackWebhook: parsed.slackWebhook,
      outputMode: parsed.outputMode,
      force: parsed.force,
      io,
    });
    return 0;
  } catch (e) {
    error(`workflow generate combined-with-triage: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
