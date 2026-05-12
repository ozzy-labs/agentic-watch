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

/**
 * CSS selector ruleset for `kind: html` sources.
 *
 * HTML scraping cannot rely on a standard envelope the way RSS/Atom does, so
 * each site declares the selectors needed to locate items and extract fields.
 * The adapter walks every element matched by `item`, then applies the
 * remaining selectors relative to that element.
 *
 * - `item` and `title` are required: without an item boundary or a title we
 *   cannot derive a stable id or produce a meaningful `Item`.
 * - `link` is required because `Item.url` is the only field every downstream
 *   consumer (research / review / dedup) depends on.
 * - `summary` / `publishedAt` / `body` / `tags` are optional; missing fields
 *   simply drop out of the normalized item (mirrors RSS adapter behavior).
 * - `publishedAt` is parsed via `new Date(text)`; the adapter prefers a
 *   `datetime` / `content` attribute when the matched element exposes one
 *   (e.g. `<time datetime="…">`), falling back to text content.
 *
 * See `docs/design/source-html.md` for the parser choice rationale and the
 * selector contract in full.
 */
export const SourceSelectorsSchema = z.object({
  item: z.string().min(1),
  title: z.string().min(1),
  link: z.string().min(1),
  summary: z.string().optional(),
  publishedAt: z.string().optional(),
  body: z.string().optional(),
  tags: z.string().optional(),
});
export type SourceSelectors = z.infer<typeof SourceSelectorsSchema>;

export const SourceSchema = z
  .object({
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
    // `selectors` is required for `kind: html` and ignored for the other
    // kinds. We model it as optional at the field level and enforce the
    // "required when html" rule via a refinement so the same Source type
    // serializes cleanly for both cases.
    selectors: SourceSelectorsSchema.optional(),
  })
  .refine((s) => s.kind !== "html" || s.selectors !== undefined, {
    message: "selectors is required when kind is 'html'",
    path: ["selectors"],
  });
export type Source = z.infer<typeof SourceSchema>;
