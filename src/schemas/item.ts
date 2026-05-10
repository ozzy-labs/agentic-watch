import { z } from "zod";

export const ItemSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  title: z.string(),
  url: z.string().url(),
  publishedAt: z.string().datetime().optional(),
  fetchedAt: z.string().datetime(),
  summary: z.string().optional(),
  raw: z.unknown().optional(),
  matchedKeywords: z.array(z.string()).default([]),
});
export type Item = z.infer<typeof ItemSchema>;
