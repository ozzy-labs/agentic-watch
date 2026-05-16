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
 *
 * Phase 5 contract: `supersedes` records the lineage between research file
 * versions. v1 files write `null`; v(N+1) files write the previous version's
 * `id` (filename without the `.md` extension). The field is `null`-defaulted
 * so existing v1 frontmatter generated before Phase 5 (which omits the field
 * entirely) parses without violating the schema. See ADR-0003.
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
  supersedes: z.string().min(1).nullable().default(null),
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
