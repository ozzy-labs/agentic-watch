import { z } from "zod";

export const SourceKindSchema = z.enum([
  "rss",
  "html",
  "html-js",
  "github-releases",
  "npm-registry",
  "json-feed",
]);
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

/**
 * Trust level for a Source (ADR-0009 M4).
 *
 * Tags whether the content returned by this source's adapter should be treated
 * as agent-controllable. The default is `"untrusted"` so omitting the field
 * (the only state existing source YAMLs are in) preserves the current
 * defense-in-depth posture: every external feed is treated as adversarial
 * until the user explicitly opts in.
 *
 * This issue only adds the field. Downstream policy branches (regex detection
 * sensitivity, boundary marker strength, prompt builder behavior) land in a
 * separate sub-issue so the schema change is reviewable in isolation.
 */
export const TrustLevelSchema = z.enum(["trusted", "untrusted"]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

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

/**
 * Optional JS rendering options for `kind: html-js` sources (ADR-0010).
 *
 * The adapter delegates fetching to a headless Chromium via Playwright. These
 * options expose the few knobs users actually need to tune per source; all
 * hardening policy (headless / acceptDownloads / fresh context / viewport)
 * is hardcoded in the adapter and intentionally NOT user-configurable.
 *
 * - `waitFor`: CSS selector to wait for before reading `page.content()`.
 *   Defaults at adapter level to `selectors.item` so the common case "wait
 *   until the item list has rendered" needs no extra config.
 * - `waitUntil`: Playwright `page.goto()` lifecycle event. `networkidle` is
 *   the safest default for SPA/CSR pages where item data arrives via XHR
 *   after the document has loaded.
 * - `timeout`: Per-step timeout (goto, waitForSelector) in milliseconds.
 *   Caps OOM / infinite-loop risk on pathological pages.
 * - `userAgent`: Optional UA override. Most sites accept the default
 *   Chromium UA; override only when a site gates content behind a UA check.
 */
export const SourceJsOptionsSchema = z.object({
  waitFor: z.string().optional(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("networkidle"),
  timeout: z.number().int().positive().default(30000),
  userAgent: z.string().optional(),
});
export type SourceJsOptions = z.infer<typeof SourceJsOptionsSchema>;

/**
 * Validate `Source.url` per kind.
 *
 * Every kind except `npm-registry` requires a fully-qualified `http(s)` URL.
 * The npm adapter accepts both the bare-package form (`@scope/pkg` or `pkg`)
 * and the `https://www.npmjs.com/package/<pkg>` URL — see ADR-0002 — so we
 * only enforce non-empty for that kind and let the adapter
 * (`extractPackageName()`) canonicalize.
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
    // `selectors` is required for `kind: html` and `kind: html-js`, ignored
    // for the other kinds. We model it as optional at the field level and
    // enforce the "required when html / html-js" rule via a refinement so the
    // same Source type serializes cleanly for both cases.
    selectors: SourceSelectorsSchema.optional(),
    // `js` is only consulted by the `html-js` adapter. Marked optional so
    // existing source YAMLs (and `kind: html` ones) parse unchanged; the
    // adapter applies defaults when the field is omitted entirely.
    js: SourceJsOptionsSchema.optional(),
    // `trustLevel` defaults to `"untrusted"` so existing source YAMLs (which
    // omit the field entirely) keep their current treatment. Per ADR-0009 M4
    // this is schema-only; policy branches that read `trustLevel` arrive in a
    // separate sub-issue.
    trustLevel: TrustLevelSchema.default("untrusted"),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== "npm-registry" && !isValidHttpUrl(value.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Invalid url",
      });
    }
    if ((value.kind === "html" || value.kind === "html-js") && value.selectors === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["selectors"],
        message: `selectors is required when kind is '${value.kind}'`,
      });
    }
  });
export type Source = z.infer<typeof SourceSchema>;
