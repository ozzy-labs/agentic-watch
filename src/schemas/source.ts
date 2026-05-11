import { z } from "zod";

export const SourceKindSchema = z.enum(["rss", "html", "github-releases", "npm-registry"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceSchema = z.object({
  id: z.string().min(1),
  kind: SourceKindSchema,
  url: z.string().url(),
  name: z.string().optional(),
  tags: z.array(z.string()).default([]),
  filters: z
    .object({
      keywords: z.array(z.string()).default([]),
      excludeKeywords: z.array(z.string()).default([]),
    })
    .partial()
    .default({}),
});
export type Source = z.infer<typeof SourceSchema>;
