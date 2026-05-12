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
 * Validate `Source.url` per kind.
 *
 * Every kind except `npm-registry` requires a fully-qualified `http(s)` URL.
 * The npm adapter accepts both the bare-package form (`@scope/pkg` or `pkg`)
 * and the `https://www.npmjs.com/package/<pkg>` URL — see ADR-0002 — so we
 * only enforce non-empty for that kind and let the adapter
 * (`extractPackageName()`) canonicalize. Doing the relaxation here (rather
 * than swapping to a `discriminatedUnion`) keeps the rest of the schema flat
 * and preserves the `z.infer` shape callers already depend on.
 */
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const SourceSchema = z
  .object({
    id: z.string().min(1),
    kind: SourceKindSchema,
    url: z.string().min(1),
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
  })
  .superRefine((value, ctx) => {
    if (value.kind === "npm-registry") return;
    if (!isValidHttpUrl(value.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Invalid url",
      });
    }
  });
export type Source = z.infer<typeof SourceSchema>;
