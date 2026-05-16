import { spawn } from "node:child_process";
import type { AgentAdapter, ResearchRequest, ReviewRequest, UpdateRequest } from "./types.js";

/**
 * Build the prompt handed to `codex exec`.
 *
 * Kept intentionally thin: the heavy lifting (research procedure, output
 * format, version policy) lives in `.agents/skills/research/SKILL.md` so the
 * adapter does not duplicate ADR-0003 / SKILL contract details. The prompt
 * here just tells Codex which skill to execute, where to write, and that
 * the structured inputs are appended in a `<stdin>` block by the CLI.
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
    "Inputs (one JSON document appended in the `<stdin>` block):",
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
 * Build the prompt handed to `codex exec` for review.
 *
 * Same shape as the research prompt: thin wrapper that points the agent at
 * `.agents/skills/review/SKILL.md` and re-states the critical filesystem
 * invariants. The procedural detail (review perspectives, where the review
 * block lands inside the file, frontmatter stamp format) lives in the SKILL
 * body, not here, so behavioural changes ship via SKILL.md updates without
 * recompiling the CLI.
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
/**
 * Build the prompt handed to `codex exec` for update.
 *
 * Symmetric with the research / review prompts: thin wrapper that points the
 * agent at `.agents/skills/update/SKILL.md` and re-states the critical
 * filesystem invariants for the v+1 generation (rewrite-and-supersede). The
 * structured inputs arrive in the `<stdin>` block appended by the Codex CLI.
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
    "Inputs (one JSON document appended in the `<stdin>` block):",
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

function buildReviewPrompt(req: ReviewRequest): string {
  return [
    "Run the `.agents/skills/review/SKILL.md` skill to cross-check the",
    "existing research report and append a review block.",
    "",
    "Inputs (one JSON document appended in the `<stdin>` block):",
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

interface SpawnOptions {
  cwd: string;
  stdin: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `codex exec <prompt> --cd <cwd> --skip-git-repo-check
 * --dangerously-bypass-approvals-and-sandbox`.
 *
 * Codex CLI non-interactive mode invocation details:
 *
 * - `codex exec` is the headless equivalent of the interactive TUI. It
 *   accepts the prompt as a positional argument and reads any piped stdin
 *   as an additional `<stdin>` block appended to the prompt. We feed the
 *   structured request JSON via stdin so the SKILL can parse it the same
 *   way as the Claude Code adapter.
 * - `--cd <dir>` (a.k.a. `-C`) sets the agent working root. We point it at
 *   the workspace so `.agents/skills/`, `items/`, `research/` resolve to
 *   the same paths the CLI uses.
 * - `--skip-git-repo-check` lets the adapter run in workspaces that are not
 *   git repos (tests use `mkdtemp` directories; real users may also lack a
 *   git root when first trying the CLI).
 * - `--dangerously-bypass-approvals-and-sandbox` is required for unattended
 *   execution: without it Codex will pause for human approval before
 *   writing files, which breaks the `research` / `review` flows where the
 *   agent must write to `outputPath` / `researchPath` autonomously. This is
 *   the Codex analogue of `--permission-mode bypassPermissions` in Claude
 *   Code (see src/agents/claude-code.ts). The CLI is itself running as a
 *   user-initiated workspace tool, so the sandbox bypass is acceptable.
 *
 * Stdin receives the structured request JSON. The agent is expected to write
 * the Markdown report itself; this function only verifies the child exits 0
 * and surfaces its stdout/stderr to the caller for logging.
 */
async function runCodexCli(prompt: string, options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "exec",
        prompt,
        "--cd",
        options.cwd,
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
      ],
      { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
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
            ? "codex CLI not found in PATH — install Codex CLI and authenticate (`codex login`) before running `agentic-watch research` / `review`."
            : `codex CLI failed to start: ${err.message}`,
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
 * actually running the `codex` CLI.
 */
export type CodexRunner = (prompt: string, options: SpawnOptions) => Promise<SpawnResult>;

interface CodexCliAdapterOptions {
  run?: CodexRunner;
}

/**
 * Heuristic to surface a user-friendly error when `codex exec` exits non-zero
 * because the CLI is not authenticated. Codex prints messages mentioning
 * `codex login` / `not authenticated` / `unauthorized` / `401` in those
 * cases; rather than swallow them inside a generic exit-code error, we
 * promote the diagnostic so users know to run `codex login`.
 */
function isAuthError(output: string): boolean {
  const haystack = output.toLowerCase();
  return (
    haystack.includes("codex login") ||
    haystack.includes("not authenticated") ||
    haystack.includes("unauthorized") ||
    haystack.includes("401")
  );
}

/**
 * Construct the Codex CLI agent adapter.
 *
 * The default adapter shells out to the real `codex` CLI. The override hook
 * exists so tests can register a mock runner via `createCodexCliAdapter`
 * (or `registerAgentAdapter`) without touching the user's installed CLI.
 */
export function createCodexCliAdapter(options: CodexCliAdapterOptions = {}): AgentAdapter {
  const run = options.run ?? runCodexCli;
  return {
    id: "codex-cli",
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
        if (isAuthError(`${result.stderr}\n${result.stdout}`)) {
          throw new Error(
            `codex-cli adapter: codex CLI is not authenticated — run \`codex login\` and retry. Original output: ${tail}`,
          );
        }
        throw new Error(`codex-cli adapter: codex CLI exited with code ${result.code}: ${tail}`);
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
        if (isAuthError(`${result.stderr}\n${result.stdout}`)) {
          throw new Error(
            `codex-cli adapter: codex CLI is not authenticated — run \`codex login\` and retry. Original output: ${tail}`,
          );
        }
        throw new Error(`codex-cli adapter: codex CLI exited with code ${result.code}: ${tail}`);
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
        if (isAuthError(`${result.stderr}\n${result.stdout}`)) {
          throw new Error(
            `codex-cli adapter: codex CLI is not authenticated — run \`codex login\` and retry. Original output: ${tail}`,
          );
        }
        throw new Error(`codex-cli adapter: codex CLI exited with code ${result.code}: ${tail}`);
      }
    },
  };
}

export const codexCliAdapter: AgentAdapter = createCodexCliAdapter();
