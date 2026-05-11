import type { AgentId, Item, ResearchFrontmatter } from "../schemas/index.js";

export interface ResearchRequest {
  agent: AgentId;
  templateId: string;
  templateBody: string;
  items: Item[];
  outputPath: string;
  /**
   * Working directory for the agent CLI invocation.
   *
   * Adapters spawn the underlying agent CLI as a child process. The agent
   * needs to be rooted at the workspace so it can read `items/`, write
   * `research/`, and resolve relative paths the same way the CLI does.
   */
  cwd: string;
}

/**
 * Inputs for the `review` adapter method.
 *
 * Phase 2 contract ([ADR-0001](../../docs/adr/0001-agent-adapter-interface.md)
 * / [ADR-0003](../../docs/adr/0003-output-format-and-versioning.md) /
 * [ADR-0008](../../docs/adr/0008-status-state-machine.md)):
 *
 * - The CLI loads the research file, parses its frontmatter, and hands the
 *   adapter both the parsed frontmatter and the original file body. The agent
 *   needs the body so it can read the research content and append a review
 *   block to the same file at `researchPath`.
 * - The adapter is responsible only for **agent-side mutations** (appending
 *   the review block + stamping `reviewedAt` / `reviewedBy` in frontmatter).
 *   The CLI handles the `items/<id>.yaml` `researched → reviewed` transition
 *   and the atomic rollback if the adapter fails partway.
 * - `templateBody` mirrors `ResearchRequest.templateBody`: empty string means
 *   "use the SKILL's built-in default review structure".
 */
export interface ReviewRequest {
  agent: AgentId;
  templateId: string;
  templateBody: string;
  /** Absolute path to the research file the agent must read and modify. */
  researchPath: string;
  /** Parsed frontmatter of the research file (pre-review state). */
  researchFrontmatter: ResearchFrontmatter;
  /** Raw body of the research file (with frontmatter) at adapter invocation. */
  researchBody: string;
  /**
   * Working directory for the agent CLI invocation. Same role as
   * `ResearchRequest.cwd`: rooted at the workspace so the agent can read
   * `items/`, `sources/`, etc. with relative paths.
   */
  cwd: string;
}

export interface AgentAdapter {
  id: AgentId;
  research: (req: ResearchRequest) => Promise<void>;
  review: (req: ReviewRequest) => Promise<void>;
}
