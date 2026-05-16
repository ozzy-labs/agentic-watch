import { spawn } from "node:child_process";
import type { AgentAdapter, ResearchRequest, ReviewRequest, UpdateRequest } from "./types.js";

/**
 * Build the prompt handed to `copilot -p`.
 *
 * Same shape and SKILL contract as the claude-code adapter (see
 * `src/agents/claude-code.ts`): we keep the prompt thin and point the agent
 * at `.agents/skills/research/SKILL.md`, which owns the procedural detail
 * (research layout, frontmatter, ADR-0003 format). The structured inputs
 * arrive on stdin as a single JSON document.
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
 * Build the prompt handed to `copilot -p` for review.
 *
 * Mirrors the claude-code review prompt; the differences between the two
 * adapters are only at the spawn boundary (flag set, ENOENT message). The
 * procedural detail (review block layout, frontmatter stamp, where to write)
 * lives in `.agents/skills/review/SKILL.md`.
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
 * Build the prompt handed to `copilot -p` for update.
 *
 * Mirrors the research / review prompts; differences between the four
 * adapters live only at the spawn boundary (flag set, ENOENT message). The
 * procedural detail (rewrite-and-supersede strategy, materiality judgement,
 * diff block layout) lives in `.agents/skills/update/SKILL.md`.
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
 * Run `copilot -p <prompt> --allow-all-paths --allow-all-tools --no-color`.
 *
 * Stdin receives the structured request JSON. The agent is expected to write
 * the Markdown report itself; this function only verifies the child exits 0
 * and surfaces its stdout/stderr to the caller for logging.
 *
 * Authentication note: GitHub Copilot CLI requires the user to have run
 * `copilot auth login` (or equivalent) ahead of time. When the CLI exits
 * non-zero because of a missing/expired token, the adapter caller surfaces
 * stderr verbatim — Copilot CLI itself prints a user-friendly hint
 * ("not authenticated — run `copilot auth login`"), so we do not try to
 * second-guess that message here.
 */
async function runCopilotCli(prompt: string, options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "copilot",
      ["-p", prompt, "--allow-all-paths", "--allow-all-tools", "--no-color"],
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
            ? "copilot CLI not found in PATH — install GitHub Copilot CLI and authenticate (`copilot auth login`) before running `agentic-watch research --agent copilot`."
            : `copilot CLI failed to start: ${err.message}`,
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
 * actually running the `copilot` CLI.
 */
export type CopilotRunner = (prompt: string, options: SpawnOptions) => Promise<SpawnResult>;

interface CopilotAdapterOptions {
  run?: CopilotRunner;
}

/**
 * Detect a Copilot CLI authentication failure from stderr/stdout text.
 *
 * Copilot prints a recognizable hint on auth failure; we re-emit it with a
 * `copilot adapter:` prefix and the canonical `copilot auth login` remediation
 * so the user does not have to dig through child output. Detection is
 * heuristic (string match) because Copilot CLI does not expose a dedicated
 * exit code for auth.
 */
function isAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("not authenticated") ||
    lower.includes("authentication required") ||
    lower.includes("auth login") ||
    lower.includes("401") ||
    lower.includes("unauthorized")
  );
}

/**
 * Construct the Copilot adapter.
 *
 * The default adapter shells out to the real `copilot` CLI. The override hook
 * exists so unit tests can register a fake spawner without touching the
 * user's installed CLI.
 */
export function createCopilotAdapter(options: CopilotAdapterOptions = {}): AgentAdapter {
  const run = options.run ?? runCopilotCli;
  return {
    id: "copilot",
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
        if (isAuthError(tail)) {
          throw new Error(
            `copilot adapter: GitHub Copilot CLI is not authenticated — run \`copilot auth login\` and retry. (CLI output: ${tail})`,
          );
        }
        throw new Error(`copilot adapter: copilot CLI exited with code ${result.code}: ${tail}`);
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
        if (isAuthError(tail)) {
          throw new Error(
            `copilot adapter: GitHub Copilot CLI is not authenticated — run \`copilot auth login\` and retry. (CLI output: ${tail})`,
          );
        }
        throw new Error(`copilot adapter: copilot CLI exited with code ${result.code}: ${tail}`);
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
        if (isAuthError(tail)) {
          throw new Error(
            `copilot adapter: GitHub Copilot CLI is not authenticated — run \`copilot auth login\` and retry. (CLI output: ${tail})`,
          );
        }
        throw new Error(`copilot adapter: copilot CLI exited with code ${result.code}: ${tail}`);
      }
    },
  };
}

export const copilotAdapter: AgentAdapter = createCopilotAdapter();
