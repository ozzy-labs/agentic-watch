import { z } from "zod";

export const SourceStateSchema = z.object({
  sourceId: z.string().min(1),
  lastFetchedAt: z.string().datetime().optional(),
  lastEtag: z.string().optional(),
  lastSeenIds: z.array(z.string()).default([]),
});
export type SourceState = z.infer<typeof SourceStateSchema>;

export const StateFileSchema = z.object({
  version: z.literal(1),
  sources: z.array(SourceStateSchema).default([]),
});
export type StateFile = z.infer<typeof StateFileSchema>;
