import { z } from "zod";

/**
 * Item status state machine (ADR-0008).
 *
 *   detected ──► (dismissed | researched) ──► reviewed
 *
 * - `detected`: watch run emitted the item after filter
 * - `dismissed`: user decided not to research (terminal)
 * - `researched`: research report written
 * - `reviewed`: research report reviewed (terminal happy path)
 */
export const ItemStatusSchema = z.enum(["detected", "dismissed", "researched", "reviewed"]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

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
  status: ItemStatusSchema.default("detected"),
});
export type Item = z.infer<typeof ItemSchema>;
