import { z } from "zod";

export const SourceStateSchema = z.object({
  sourceId: z.string().min(1),
  lastFetchedAt: z.string().datetime().optional(),
  lastEtag: z.string().optional(),
  // HTTP `Last-Modified` is RFC 1123 (e.g. "Wed, 21 Oct 2015 07:28:00 GMT"),
  // not ISO 8601. We keep the server-supplied string verbatim so the adapter
  // can echo it back in `If-Modified-Since` without re-formatting.
  lastModified: z.string().optional(),
  lastSeenIds: z.array(z.string()).default([]),
});
export type SourceState = z.infer<typeof SourceStateSchema>;

export const StateFileSchema = z.object({
  version: z.literal(1),
  sources: z.array(SourceStateSchema).default([]),
});
export type StateFile = z.infer<typeof StateFileSchema>;
