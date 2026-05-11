import { z } from "zod";

export const SourceKindSchema = z.enum(["rss", "html", "github-releases", "npm-registry"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/**
 * Match modes for keyword evaluation (ADR-0006).
 *
 * - `word`: whole-word match (`\b<kw>\b`). Default; safest for casual blog feeds.
 * - `substring`: simple substring match. Use for partial-token monitoring.
 * - `regex`: keyword is compiled as a JavaScript RegExp. Invalid patterns throw.
 *   Beware ReDoS; users own pattern complexity.
 */
export const MatchModeSchema = z.enum(["word", "substring", "regex"]);
export type MatchMode = z.infer<typeof MatchModeSchema>;

/** Item fields a filter may inspect (ADR-0006). Adapters silently skip fields they cannot supply. */
export const MatchFieldSchema = z.enum(["title", "summary", "body", "tags"]);
export type MatchField = z.infer<typeof MatchFieldSchema>;

export const SourceFiltersSchema = z.object({
  keywords: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  matchMode: MatchModeSchema.default("word"),
  matchFields: z.array(MatchFieldSchema).default(["title", "summary"]),
  caseSensitive: z.boolean().default(false),
});
export type SourceFilters = z.infer<typeof SourceFiltersSchema>;

export const SourceSchema = z.object({
  id: z.string().min(1),
  kind: SourceKindSchema,
  url: z.string().url(),
  name: z.string().optional(),
  tags: z.array(z.string()).default([]),
  // Default `filters` to a fully-populated object so a source missing the
  // entire `filters` block still parses. Zod 4's `.default()` takes the
  // post-parse output (all required fields), so we cannot pass `{}`.
  filters: SourceFiltersSchema.default({
    keywords: [],
    excludeKeywords: [],
    matchMode: "word",
    matchFields: ["title", "summary"],
    caseSensitive: false,
  }),
});
export type Source = z.infer<typeof SourceSchema>;
