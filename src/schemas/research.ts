import { z } from "zod";

export const AgentIdSchema = z.enum(["claude-code", "codex-cli", "gemini-cli", "copilot"]);
export type AgentId = z.infer<typeof AgentIdSchema>;

/**
 * Frontmatter persisted on disk in `research/<id>.md`.
 *
 * `outputPath` is intentionally **omitted** here: the path is encoded in the
 * filename itself, so storing it in the frontmatter would be redundant and
 * invite drift between the two. Anything that needs the path can construct it
 * from `id` (filename) or read it from the file system. This split keeps the
 * persisted artifact ADR-0003-compliant while letting in-memory orchestration
 * carry the resolved path through `Research`.
 *
 * Phase 1 contract: `reviewedAt` / `reviewedBy` are **always written as
 * `null`** by the `research` command. They become non-null when Phase 2's
 * `review` command stamps the file. See ADR-0003.
 */
export const ResearchFrontmatterSchema = z.object({
  id: z.string().min(1),
  itemIds: z.array(z.string().min(1)).min(1),
  agent: AgentIdSchema,
  templateId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  reviewedBy: AgentIdSchema.nullable(),
});
export type ResearchFrontmatter = z.infer<typeof ResearchFrontmatterSchema>;

/**
 * In-memory Research record used by the orchestration layer.
 *
 * Extends `ResearchFrontmatter` with `outputPath`, which the CLI needs to
 * pass through to the agent adapter (so the agent knows where to write) and
 * back to the caller (so the CLI can verify the file after the adapter
 * returns). Persisted frontmatter intentionally drops this field.
 */
export const ResearchSchema = ResearchFrontmatterSchema.extend({
  outputPath: z.string().min(1),
});
export type Research = z.infer<typeof ResearchSchema>;
