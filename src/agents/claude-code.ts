import { spawn } from "node:child_process";
import type { AgentAdapter, ResearchRequest } from "./types.js";

/**
 * Build the prompt handed to `claude -p`.
 *
 * Kept intentionally thin: the heavy lifting (research procedure, output
 * format, version policy) lives in `.agents/skills/research/SKILL.md` so the
 * adapter does not duplicate ADR-0003 / SKILL contract details. The prompt
 * here just tells Claude which skill to execute, where to write, and that
 * the structured inputs are on stdin.
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
function buildPrompt(req: ResearchRequest): string {
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
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `claude -p <prompt> --output-format text --permission-mode bypassPermissions`.
 *
 * Stdin receives the structured request JSON. The agent is expected to write
 * the Markdown report itself; this function only verifies the child exits 0
 * and surfaces its stdout/stderr to the caller for logging.
 */
async function runClaudeCli(prompt: string, options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", prompt, "--output-format", "text", "--permission-mode", "bypassPermissions"],
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
            ? "claude CLI not found in PATH — install Claude Code and authenticate before running `agentic-watch research`."
            : `claude CLI failed to start: ${err.message}`,
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
 * actually running the `claude` CLI.
 */
export type ClaudeRunner = (prompt: string, options: SpawnOptions) => Promise<SpawnResult>;

interface ClaudeCodeAdapterOptions {
  run?: ClaudeRunner;
}

/**
 * Construct the Claude Code agent adapter.
 *
 * The default adapter shells out to the real `claude` CLI. The override hook
 * exists so the CLI test (`tests/cli/research.test.ts`) can register a mock
 * adapter through the registry without touching the user's installed CLI.
 */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): AgentAdapter {
  const run = options.run ?? runClaudeCli;
  return {
    id: "claude-code",
    research: async (req) => {
      const prompt = buildPrompt(req);
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
        throw new Error(`claude-code adapter: claude CLI exited with code ${result.code}: ${tail}`);
      }
    },
  };
}

export const claudeCodeAdapter: AgentAdapter = createClaudeCodeAdapter();
