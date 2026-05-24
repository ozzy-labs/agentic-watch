import type { Locale } from "../core/locale.js";
import type { AgentId, Item, ResearchFrontmatter } from "../schemas/index.js";

/**
 * Low-level stream pass-through callback (ADR-0015 D3).
 *
 * Adapters wire this to each `child.stdout` / `child.stderr` `"data"` chunk
 * so the caller (`research` / `review` / `update` CLI in #197) can keep a
 * `ProgressReporter` ticking — e.g. update `stdout: 4.2 KB` on the spinner
 * row, or stream the chunk verbatim under `--verbose`.
 *
 * Stays at the lowest level (raw chunk text) so the adapter contract does
 * not have to know about the `ProgressReporter` shape; callers translate
 * chunks into reporter calls. `kind` distinguishes streams because some
 * callers render stderr differently (warning colour, separate buffer).
 *
 * Optional everywhere: leaving `onProgress` unset is byte-equivalent to the
 * pre-#196 adapter behaviour.
 */
export type AgentProgressCallback = (kind: "stdout" | "stderr", text: string) => void;

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
  /**
   * Optional progress callback. Invoked once per `stdout` / `stderr` chunk
   * from the spawned agent CLI. Unset means "no progress reporting"
   * (#196 forward-compat: existing call sites work unchanged).
   */
  onProgress?: AgentProgressCallback;
  /**
   * Effective UI locale resolved by the CLI (ADR-0021, epic #307 / #316).
   *
   * Controls the **output language of the generated report body** only. The
   * prompt itself stays in English (the SKILL is the canonical English
   * procedure — ADR-0021 §5); the adapter appends a short output-language
   * directive built from this locale so prose (summary / details) matches the
   * per-locale template headings the CLI also passes via `templateBody`.
   *
   * Does NOT translate the report `# <Title>` (item title is in the source
   * language) or the digest filename slug.
   */
  locale: Locale;
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
  /**
   * Optional progress callback. See {@link AgentProgressCallback} /
   * {@link ResearchRequest.onProgress}.
   */
  onProgress?: AgentProgressCallback;
  /**
   * Effective UI locale resolved by the CLI. See
   * {@link ResearchRequest.locale}: controls the output language of the review
   * block prose; the prompt stays English (ADR-0021 §5).
   */
  locale: Locale;
}

/**
 * Inputs for the `update` adapter method.
 *
 * Phase 5 contract ([ADR-0001](../../docs/adr/0001-agent-adapter-interface.md)
 * / [ADR-0003](../../docs/adr/0003-output-format-and-versioning.md) /
 * [ADR-0008](../../docs/adr/0008-status-state-machine.md), and the design pin
 * in `docs/design/skill-design.md` §2 / §8):
 *
 * - The CLI loads the previous version's research file (frontmatter + body)
 *   and hands the adapter both alongside the new output path. The agent
 *   regenerates the report end-to-end (rewrite-and-supersede strategy
 *   confirmed in skill-design.md §8.2) and writes the v+1 file at
 *   `outputPath`.
 * - The adapter is responsible only for **agent-side mutations** (writing the
 *   new file with the correct frontmatter, including `supersedes: <prev id>`,
 *   `reviewedAt: null`, `reviewedBy: null`, and the v1 `createdAt` preserved).
 *   The CLI handles validation, the `_v(N+1)` filename derivation, and the
 *   `items.yaml` `status` invariant (ADR-0008: `update` never changes status).
 * - `templateBody` mirrors `ResearchRequest.templateBody`: empty string means
 *   "use the SKILL's built-in default research structure". The `update` SKILL
 *   re-uses the research SKILL body internally, so the same template applies.
 * - `prevResearch` carries the previous version's parsed frontmatter and
 *   raw body so the agent can re-fetch upstream sources, judge materiality,
 *   and emit a `## v<N+1> での変更点` block referencing v(N) content.
 */
export interface UpdateRequest {
  agent: AgentId;
  templateId: string;
  templateBody: string;
  /** Previous version frontmatter + raw body (with frontmatter). */
  prevResearch: {
    frontmatter: ResearchFrontmatter;
    body: string;
  };
  /** Items linked from the previous research (preserved on v+1, ADR-0003). */
  items: Item[];
  /** Absolute path where the agent MUST write the new `_v(N+1).md` file. */
  outputPath: string;
  /**
   * Working directory for the agent CLI invocation. Same role as
   * `ResearchRequest.cwd`: rooted at the workspace so the agent can read
   * `items/`, `sources/`, etc. with relative paths.
   */
  cwd: string;
  /**
   * Optional progress callback. See {@link AgentProgressCallback} /
   * {@link ResearchRequest.onProgress}.
   */
  onProgress?: AgentProgressCallback;
  /**
   * Effective UI locale resolved by the CLI. See
   * {@link ResearchRequest.locale}: controls the output language of the
   * regenerated report body; the prompt stays English (ADR-0021 §5).
   */
  locale: Locale;
}

export interface AgentAdapter {
  id: AgentId;
  research: (req: ResearchRequest) => Promise<void>;
  review: (req: ReviewRequest) => Promise<void>;
  update: (req: UpdateRequest) => Promise<void>;
}
