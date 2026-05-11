import { z } from "zod";

export const AgentIdSchema = z.enum(["claude-code", "codex-cli", "gemini-cli", "copilot"]);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const ResearchSchema = z.object({
  id: z.string().min(1),
  itemIds: z.array(z.string().min(1)).min(1),
  agent: AgentIdSchema,
  templateId: z.string().min(1),
  outputPath: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});
export type Research = z.infer<typeof ResearchSchema>;
