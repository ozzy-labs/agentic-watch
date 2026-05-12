import { spawn } from "node:child_process";
import type { AgentAdapter, ResearchRequest } from "./types.js";

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
 * Run `gemini -p <prompt> -y --output-format text`.
 *
 * Stdin receives the structured request JSON. `-y` (YOLO mode) auto-approves
 * file-tool prompts so the agent can write the research file without blocking
 * on a TTY. The agent is expected to write the Markdown report itself; this
 * function only verifies the child exits 0 and surfaces its stdout/stderr to
 * the caller for logging.
 *
 * On `ENOENT` we report a missing-CLI error pointing at the install + auth
 * step (`agentic-watch research` cannot proceed without an authenticated
 * Gemini CLI on PATH).
 */
async function runGeminiCli(prompt: string, options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gemini", ["-p", prompt, "-y", "--output-format", "text"], {
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
    review: async (_req) => {
      // Implemented in the next commit on this branch.
      throw new Error("gemini-cli adapter: review not implemented yet (Phase 2)");
    },
  };
}

export const geminiCliAdapter: AgentAdapter = createGeminiCliAdapter();
