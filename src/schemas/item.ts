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
  /**
   * Prompt-injection pattern labels that fired when the watcher scanned
   * `title` / `summary` / `raw` (ADR-0009 M1a — Adopt). Audit-only: a
   * non-empty value does NOT change `status`, sanitize content, or block
   * downstream commands. Existing items written before this field landed
   * default to `[]` thanks to the schema default, so load-side compat is
   * automatic.
   */
  injectionFlags: z.array(z.string()).default([]),
});
export type Item = z.infer<typeof ItemSchema>;
