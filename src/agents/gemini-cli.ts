import { spawn } from "node:child_process";
import type { AgentAdapter, ResearchRequest, ReviewRequest, UpdateRequest } from "./types.js";

/**
 * Build the prompt handed to `gemini -p`.
 *
 * Mirrors the claude-code adapter's prompt shape (see `claude-code.ts`): the
 * heavy lifting (research procedure, output format, version policy) lives in
 * `.agents/skills/research/SKILL.md`, so the adapter only points the agent at
 * the skill, identifies the structured stdin payload, and re-states the
 * critical filesystem invariants.
 *
 * The Gemini CLI is non-interactive when launched with `-p`. We additionally
 * pass `-y` (YOLO mode / approval skip) so the agent can read/write files
 * without prompting for tool approvals — required for headless invocation
 * from `agentic-watch research`.
 *
 * Stdin payload schema (JSON):
 *   {
 *     "agent":        AgentId,
 *     "templateId":   string,
 *     "templateBody": string,  // empty string => use SKILL's built-in default
 *     "items":        Item[],
 *     "outputPath":   string
 *   }
 */
function buildResearchPrompt(req: ResearchRequest): string {
  const itemIds = req.items.map((i) => i.id).join(", ");
  return [
    "Run the `.agents/skills/research/SKILL.md` skill to produce a Markdown",
    "research report from the supplied detected items.",
    "",
    "Inputs (one JSON document on stdin):",
    "  - agent:        the agent id you are running as",
    "  - templateId:   research template id (e.g. `default`)",
    "  - templateBody: contents of templates/<templateId>.md, or empty string",
    "                  if the workspace did not provide one (use SKILL default)",
    "  - items:        validated Item objects (see src/schemas/item.ts)",
    "  - outputPath:   absolute path where you MUST write the report",
    "",
    `Items to research: ${itemIds}`,
    `Write the Markdown report to: ${req.outputPath}`,
    "",
    "Constraints:",
    "  - Follow `.agents/skills/research/SKILL.md` exactly for layout and",
    "    frontmatter; ADR-0003 is the canonical format spec.",
    "  - Set frontmatter fields `reviewedAt: null` and `reviewedBy: null`.",
    "    The `review` command (Phase 2) stamps those later.",
    "  - Do not modify items/*.yaml — the CLI handles the status transition.",
  ].join("\n");
}

/**
 * Build the prompt handed to `gemini -p` for review.
 *
 * Symmetric with `buildResearchPrompt`: thin wrapper that points the agent
 * at `.agents/skills/review/SKILL.md` and re-states the critical filesystem
 * invariants. Procedural detail (review perspectives, where the review block
 * lands inside the file, frontmatter stamp format) lives in the SKILL body.
 *
 * Stdin payload schema (JSON):
 *   {
 *     "agent":               AgentId,
 *     "templateId":          string,
 *     "templateBody":        string,  // empty => use SKILL's built-in rubric
 *     "researchPath":        string,
 *     "researchFrontmatter": ResearchFrontmatter,
 *     "researchBody":        string
 *   }
 */
function buildReviewPrompt(req: ReviewRequest): string {
  return [
    "Run the `.agents/skills/review/SKILL.md` skill to cross-check the",
    "existing research report and append a review block.",
    "",
    "Inputs (one JSON document on stdin):",
    "  - agent:               the agent id you are running as",
    "  - templateId:          review template id (e.g. `default`)",
    "  - templateBody:        contents of templates/<templateId>.md, or empty",
    "                         string if the workspace did not provide one",
    "  - researchPath:        absolute path to the research file you MUST modify",
    "  - researchFrontmatter: parsed frontmatter object (pre-review state)",
    "  - researchBody:        full file body including frontmatter at adapter",
    "                         invocation (the CLI re-reads after you return)",
    "",
    `Research file to review: ${req.researchPath}`,
    `Reviewing agent id (stamp this into reviewedBy): ${req.agent}`,
    "",
    "Constraints:",
    "  - Follow `.agents/skills/review/SKILL.md` exactly for the review block",
    "    layout and frontmatter stamp; ADR-0003 / ADR-0008 are the canonical",
    "    contract specs.",
    "  - Set frontmatter `reviewedAt` to the current ISO 8601 timestamp (UTC)",
    "    and `reviewedBy` to the agent id above.",
    "  - Append a single `## レビュー (<agent-id>, <ISO 8601>)` section at the",
    "    end of the body. Do not rewrite the existing research content.",
    "  - Do not modify items/*.yaml — the CLI handles the status transition",
    "    and the atomic rollback if anything fails.",
    "  - Write to `researchPath` only. Do not create new files.",
  ].join("\n");
}

/**
 * Build the prompt handed to `gemini -p` for update.
 *
 * Symmetric with `buildResearchPrompt` / `buildReviewPrompt`: thin wrapper
 * that points the agent at `.agents/skills/update/SKILL.md` and re-states the
 * critical filesystem invariants for the v+1 generation. Procedural detail
 * (rewrite-and-supersede strategy, materiality judgement, diff block layout)
 * lives in the SKILL body.
 *
 * Stdin payload schema (JSON):
 *   {
 *     "agent":        AgentId,
 *     "templateId":   string,
 *     "templateBody": string,
 *     "prevResearch": { frontmatter: ResearchFrontmatter, body: string },
 *     "items":        Item[],
 *     "outputPath":   string
 *   }
 */
function buildUpdatePrompt(req: UpdateRequest): string {
  const newId = req.outputPath.replace(/^.*\//, "").replace(/\.md$/, "");
  return [
    "Run the `.agents/skills/update/SKILL.md` skill to regenerate the supplied",
    "research report as a new `_v(N+1).md` file (rewrite-and-supersede).",
    "",
    "Inputs (one JSON document on stdin):",
    "  - agent:        the agent id you are running as",
    "  - templateId:   research template id (e.g. `default`)",
    "  - templateBody: contents of templates/<templateId>.md, or empty string",
    "                  if the workspace did not provide one (use SKILL default)",
    "  - prevResearch: { frontmatter, body } of the predecessor file",
    "  - items:        validated Item objects linked from the predecessor",
    "  - outputPath:   absolute path where you MUST write the new v+1 report",
    "",
    `Predecessor research id: ${req.prevResearch.frontmatter.id}`,
    `New research id: ${newId}`,
    `Write the v+1 Markdown report to: ${req.outputPath}`,
    "",
    "Constraints:",
    "  - Follow `.agents/skills/update/SKILL.md` exactly for layout and",
    "    frontmatter; ADR-0003 is the canonical format spec.",
    `  - Set frontmatter \`supersedes: ${req.prevResearch.frontmatter.id}\``,
    "    (predecessor id, not filename).",
    `  - Preserve \`itemIds\`, \`templateId\`, and \`createdAt\` from v(N).`,
    "  - Set `reviewedAt: null` and `reviewedBy: null` (v+1 resets review state).",
    "  - Do not modify the predecessor file or any items/*.yaml — the CLI",
    "    enforces immutable history and items.yaml status invariance.",
    "  - Write to `outputPath` only. Do not create other files.",
  ].join("\n");
}

interface SpawnOptions {
  cwd: string;
  stdin: string;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Detect Gemini auth errors from the child's stderr/stdout so the CLI can
 * surface a user-friendly message instead of a generic "exited with code N".
 *
 * The Gemini CLI is still evolving and prints different strings depending on
 * the failure mode (OAuth login expired, missing API key, ADC not set, etc.).
 * We match on common substrings rather than exact messages so the heuristic
 * survives minor wording changes.
 */
function looksLikeAuthError(text: string): boolean {
  const haystack = text.toLowerCase();
  return [
    "authentication",
    "unauthenticated",
    "unauthorized",
    "not authenticated",
    "please login",
    "please log in",
    "gemini login",
    "api key",
    "credentials",
    "permission denied",
  ].some((needle) => haystack.includes(needle));
}

/**
 * Run `gemini -p <prompt> -y --skip-trust --output-format text`.
 *
 * Stdin receives the structured request JSON. `-y` (YOLO mode) auto-approves
 * file-tool prompts so the agent can write the research file without blocking
 * on a TTY. The agent is expected to write the Markdown report itself; this
 * function only verifies the child exits 0 and surfaces its stdout/stderr to
 * the caller for logging.
 *
 * `--skip-trust` bypasses the Gemini CLI folder-trust check. Recent Gemini
 * CLI versions silently downgrade `-y` (YOLO) to default approval mode when
 * the working directory is not on the trusted-folders list, surfacing as:
 *
 *   "Approval mode overridden to 'default' because the current folder is
 *    not trusted."
 *
 * This breaks headless invocation in arbitrary workspaces (`/tmp/...`, CI,
 * etc.). The other three adapters (claude-code, codex-cli, copilot) already
 * launch in equivalent full-permission modes (`--permission-mode
 * bypassPermissions` / `--dangerously-bypass-approvals-and-sandbox` /
 * `--allow-all-paths --allow-all-tools`), so adding `--skip-trust` is **not
 * a new permission grant** — it restores parity with the rest of the adapter
 * family so the `--agent` flag behaves consistently across CLIs. The
 * `GEMINI_CLI_TRUST_WORKSPACE=true` environment variable is an equivalent
 * alternative; we use the explicit flag because it does not require
 * `process.env` mutation and is easier to assert in tests.
 *
 * On `ENOENT` we report a missing-CLI error pointing at the install + auth
 * step (`agentic-watch research` cannot proceed without an authenticated
 * Gemini CLI on PATH).
 */
async function runGeminiCli(prompt: string, options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gemini", ["-p", prompt, "-y", "--skip-trust", "--output-format", "text"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      reject(
        new Error(
          err.message.includes("ENOENT")
            ? "gemini CLI not found in PATH — install Gemini CLI and authenticate (`gemini` once interactively, or set GEMINI_API_KEY) before running `agentic-watch research --agent gemini-cli`."
            : `gemini CLI failed to start: ${err.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
    child.stdin?.write(options.stdin);
    child.stdin?.end();
  });
}

/**
 * Spawner type used by the adapter. Tests inject a fake here to avoid
 * actually running the `gemini` CLI.
 */
export type GeminiRunner = (prompt: string, options: SpawnOptions) => Promise<SpawnResult>;

interface GeminiCliAdapterOptions {
  run?: GeminiRunner;
}

/**
 * Construct the Gemini CLI agent adapter.
 *
 * The default adapter shells out to the real `gemini` CLI. The override hook
 * exists so tests (`tests/agents/gemini-cli.test.ts`, plus CLI tests via
 * `registerAgentAdapter`) can substitute a fake spawn without touching the
 * user's installed CLI.
 */
export function createGeminiCliAdapter(options: GeminiCliAdapterOptions = {}): AgentAdapter {
  const run = options.run ?? runGeminiCli;
  return {
    id: "gemini-cli",
    research: async (req) => {
      const prompt = buildResearchPrompt(req);
      const stdin = `${JSON.stringify(
        {
          agent: req.agent,
          templateId: req.templateId,
          templateBody: req.templateBody,
          items: req.items,
          outputPath: req.outputPath,
        },
        null,
        2,
      )}\n`;
      const result = await run(prompt, { cwd: req.cwd, stdin });
      if (result.code !== 0) {
        const tail = result.stderr.trim() || result.stdout.trim() || "(no output)";
        if (looksLikeAuthError(`${result.stderr}\n${result.stdout}`)) {
          throw new Error(
            `gemini-cli adapter: Gemini CLI authentication failed. Run \`gemini\` interactively to log in, or set GEMINI_API_KEY, then retry. (CLI exit ${result.code}: ${tail})`,
          );
        }
        throw new Error(`gemini-cli adapter: gemini CLI exited with code ${result.code}: ${tail}`);
      }
    },
    review: async (req) => {
      const prompt = buildReviewPrompt(req);
      const stdin = `${JSON.stringify(
        {
          agent: req.agent,
          templateId: req.templateId,
          templateBody: req.templateBody,
          researchPath: req.researchPath,
          researchFrontmatter: req.researchFrontmatter,
          researchBody: req.researchBody,
        },
        null,
        2,
      )}\n`;
      const result = await run(prompt, { cwd: req.cwd, stdin });
      if (result.code !== 0) {
        const tail = result.stderr.trim() || result.stdout.trim() || "(no output)";
        if (looksLikeAuthError(`${result.stderr}\n${result.stdout}`)) {
          throw new Error(
            `gemini-cli adapter: Gemini CLI authentication failed. Run \`gemini\` interactively to log in, or set GEMINI_API_KEY, then retry. (CLI exit ${result.code}: ${tail})`,
          );
        }
        throw new Error(`gemini-cli adapter: gemini CLI exited with code ${result.code}: ${tail}`);
      }
    },
    update: async (req) => {
      const prompt = buildUpdatePrompt(req);
      const stdin = `${JSON.stringify(
        {
          agent: req.agent,
          templateId: req.templateId,
          templateBody: req.templateBody,
          prevResearch: req.prevResearch,
          items: req.items,
          outputPath: req.outputPath,
        },
        null,
        2,
      )}\n`;
      const result = await run(prompt, { cwd: req.cwd, stdin });
      if (result.code !== 0) {
        const tail = result.stderr.trim() || result.stdout.trim() || "(no output)";
        if (looksLikeAuthError(`${result.stderr}\n${result.stdout}`)) {
          throw new Error(
            `gemini-cli adapter: Gemini CLI authentication failed. Run \`gemini\` interactively to log in, or set GEMINI_API_KEY, then retry. (CLI exit ${result.code}: ${tail})`,
          );
        }
        throw new Error(`gemini-cli adapter: gemini CLI exited with code ${result.code}: ${tail}`);
      }
    },
  };
}

export const geminiCliAdapter: AgentAdapter = createGeminiCliAdapter();
