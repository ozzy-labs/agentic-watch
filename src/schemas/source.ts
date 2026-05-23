import { z } from "zod";
import { AgentIdSchema } from "./research.js";

export const SourceKindSchema = z.enum([
  "rss",
  "html",
  "html-js",
  "github-releases",
  "npm-registry",
  "json-feed",
  "json-api",
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

/**
 * Per-source triage policy (ADR-0018 §W3).
 *
 * Drives `radar triage` for items emitted from this source. Optional on
 * `SourceSchema`: existing source YAMLs (which omit `triagePolicy:` entirely)
 * remain valid and `radar triage` simply skips them.
 *
 * - `agent`: which adapter runs the triage call. Reuses `AgentIdSchema` so
 *   the same enum gates both research and triage agents (a workspace can
 *   only triage with an adapter it has wired up). The adapter is free to
 *   route the triage channel to a cheaper model than the research channel
 *   (e.g. `gemini-2.5-flash-lite` vs `gemini-2.5-pro`), but that mapping is
 *   adapter-internal and not schema-modeled here.
 * - `confidenceThreshold`: minimum confidence for a non-`unsure` decision to
 *   stick. Decisions below the threshold are demoted to `unsure` regardless
 *   of what the agent returned. Default `0.7` reflects ADR-0018's
 *   recommendation for cheap-model triage.
 * - `rules`: free-form markdown describing how this source should be
 *   classified ("AWS GA は research、リージョン拡張は dismiss" 等). Wrapped
 *   in a `<policy>` boundary marker at prompt time per ADR-0018 §W-A; never
 *   parsed by the schema beyond non-empty.
 */
export const SourceTriagePolicySchema = z.object({
  agent: AgentIdSchema,
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
  rules: z.string().min(1),
});
export type SourceTriagePolicy = z.infer<typeof SourceTriagePolicySchema>;

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
 * HTTP options for `kind: json-api` sources (ADR-0012 §D2).
 *
 * Phase 1 supports GET only. `headers` accepts arbitrary key/value pairs and
 * supports `${VAR}` env-var interpolation (resolved by the adapter, never
 * persisted to log / frontmatter — see ADR-0012 §D5c).
 *
 * The schema deliberately does not validate header values against env names —
 * the adapter handles unresolved `${VAR}` placeholders by omitting the header
 * (degraded fetch). This lets public APIs work without env wiring while
 * authenticated APIs fail-fast with a 401/403 at runtime.
 */
export const SourceHttpOptionsSchema = z.object({
  method: z.literal("GET").default("GET"),
  headers: z.record(z.string(), z.string()).default({}),
});
export type SourceHttpOptions = z.infer<typeof SourceHttpOptionsSchema>;

/**
 * Pagination configuration for `kind: json-api` sources (ADR-0012 §D2).
 *
 * Five wire formats are supported:
 *
 *   page         — `?page=K&pageSize=N` (e.g. AWS What's New, dev.to)
 *   offset       — `?offset=K&limit=N`
 *   cursor       — `?after=<cursorValue>` with `nextCursor` extracted via JSONPath
 *   link-header  — `Link: <...>; rel="next"` HTTP header
 *   token        — `?pageToken=<opaque>` opaque continuation token
 *   none         — single request, no pagination
 *
 * `maxPages` is a hard cap to prevent runaway loops / DoS on misconfigured
 * recipes. The default (20) matches a conservative bound for normal-mode
 * fetching; `--backfill` can override via `--max-pages` to walk further.
 *
 * `nextCursorPath` / `totalPath` are JSONPath-lite expressions resolved against
 * the parsed response body. `totalPath` is consulted in backfill mode to
 * compute an upper bound on pages and short-circuit early when the total is
 * known.
 */
export const SourcePaginationSchema = z.object({
  type: z.enum(["page", "offset", "cursor", "link-header", "token", "none"]),
  /**
   * Query parameter name for the page / offset / token (e.g. `page`, `offset`,
   * `after`, `pageToken`). Required for `page` / `offset` / `cursor` / `token`;
   * ignored for `link-header` / `none`.
   */
  param: z.string().min(1).optional(),
  /** Initial value (e.g. 0 for offset, 1 for page-number, undefined for cursor/token). */
  start: z.number().int().optional(),
  /** Items per page (e.g. 100 for AWS, 30 for dev.to). */
  pageSize: z.number().int().positive().optional(),
  /** Query parameter name for the page-size value. Defaults to `pageSize` when present. */
  pageSizeParam: z.string().min(1).optional(),
  /** JSONPath-lite to the next-cursor / next-token value in the response body. */
  nextCursorPath: z.string().min(1).optional(),
  /** JSONPath-lite to the total-count value in the response body (backfill-mode early-stop hint). */
  totalPath: z.string().min(1).optional(),
  /** Hard cap on pages traversed. Default 20 (normal mode); `--max-pages` overrides in backfill. */
  maxPages: z.number().int().positive().default(20),
});
export type SourcePagination = z.infer<typeof SourcePaginationSchema>;

/**
 * Selector ruleset for `kind: json-api` sources (ADR-0012 §D2).
 *
 * Every selector is a JSONPath-lite expression (`src/core/feeds/_jsonpath.ts`).
 *
 * Every field is optional. When omitted the adapter falls back to a default
 * selector chain per field (#174 / ADR-0012 §D2 defaults). For "simple"
 * page-based APIs (dev.to, JSON Feed-shaped) the recipe can therefore omit
 * `jsonSelectors` entirely (or use just `{}`) and rely on:
 *
 *   items       — `$.items[*] || $.data[*] || $.results[*] || $.posts[*] || $.entries[*] || $[*]`
 *   title       — `$.title || $.name || $.headline`
 *   link        — `$.url || $.link || $.permalink || $.html_url`
 *   publishedAt — `$.publishedAt || $.published_at || $.date || $.created_at || $.pubDate`
 *   summary     — `$.summary || $.description || $.excerpt || $.body`
 *
 * - `publisherId` has no fallback chain (stable id derivation falls through
 *   to `link` URL by default; see `derive-id.ts`).
 * - `body` / `tags` have no fallback chain (rarely needed for normalization).
 * - `linkBase` resolves relative `link` values against an explicit base URL
 *   (defaults to `source.url`). See field-level docstring for details (#204).
 *
 * Note that selectors are evaluated against each item element (already
 * dereferenced via `items`), so paths inside this schema commonly use `$` as
 * the per-item root (e.g. `$.title`, `$.created_at`).
 */
export const SourceJsonApiSelectorsSchema = z.object({
  items: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  link: z.string().min(1).optional(),
  publisherId: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  publishedAt: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  tags: z.string().min(1).optional(),
  /**
   * Base URL used to resolve relative `link` values returned by the API
   * (#204). Many APIs (e.g. AWS What's New) return `headlineUrl` as a path
   * like `/about-aws/whats-new/.../` instead of a full URL, which causes
   * every item to be silently dropped at `ItemSchema` validation. When
   * `linkBase` is set, the adapter resolves relative `link` values against
   * it (`new URL(raw, linkBase)`); when omitted, `source.url` is used as
   * the base, mirroring how the html adapter resolves `<a href="/...">`.
   * Absolute links pass through untouched in either case.
   *
   * Must be a fully-qualified http(s) URL — invalid bases would silently
   * mis-resolve, so we fail-fast at schema parse time.
   */
  linkBase: z.string().url().optional(),
});
export type SourceJsonApiSelectors = z.infer<typeof SourceJsonApiSelectorsSchema>;

/**
 * Facet sweep recipe extension for `kind: json-api` (ADR-0017).
 *
 * `facets` is an outer "data slice" axis that wraps the inner pagination
 * loop. It exists because some APIs cap their offset/page traversal at a
 * fixed total (e.g. AWS dirs API: `(page + 1) * size <= 10000`), making
 * the upper ~half of the catalog unreachable via inner pagination alone.
 * Splitting the request by a facet (year, category, …) keeps every slice
 * comfortably under the cap and recovers full-history coverage.
 *
 * Two facet types are supported in Phase 1:
 *
 * - `range`: a numeric range `[start, end]` (inclusive) walked with `step`.
 *   Useful for year sweeps where the API exposes a `year=YYYY` filter.
 * - `enum`: an explicit list of values (string / number). Useful for
 *   non-numeric or non-sequential facets (categories, regions, tags).
 *
 * The `template` must contain a literal `{}` placeholder which the
 * adapter substitutes with the current facet value (e.g.
 * `whats-new-v2#year#{}` → `whats-new-v2#year#2024`). The substituted
 * string is injected into the URL as the value of the `param` query
 * parameter.
 *
 * Multi-facet support (e.g. year × category) is explicitly deferred to a
 * future ADR; the adapter throws when more than one facet entry is
 * present. The schema allows a `Record<string, Facet>` purely for
 * forward-compatibility — single entry today, additional entries later
 * without a schema break.
 *
 * See ADR-0017 for the full design rationale (option A vs option D
 * `pagination.type: facet`, lastSeenIds-as-global semantics, conditional
 * GET disablement in facet sweep mode).
 */
export const SourceFacetRangeSchema = z
  .object({
    type: z.literal("range"),
    /** Query parameter name to inject (e.g. `tags.id`). */
    param: z.string().min(1),
    /**
     * Template string with a literal `{}` placeholder for the facet value.
     * E.g. `whats-new-v2#year#{}` → injected as `whats-new-v2#year#2024`.
     */
    template: z.string().min(1),
    /** Inclusive `[start, end]` range — both endpoints are visited. */
    range: z.tuple([z.number(), z.number()]),
    /** Step size (default 1). Must be a positive integer. */
    step: z.number().int().positive().default(1),
  })
  .superRefine((value, ctx) => {
    if (!value.template.includes("{}")) {
      ctx.addIssue({
        code: "custom",
        path: ["template"],
        message: "template must contain '{}' placeholder",
      });
    }
    if (value.range[0] > value.range[1]) {
      ctx.addIssue({
        code: "custom",
        path: ["range"],
        message: "range start must be <= end",
      });
    }
  });
export type SourceFacetRange = z.infer<typeof SourceFacetRangeSchema>;

export const SourceFacetEnumSchema = z
  .object({
    type: z.literal("enum"),
    /** Query parameter name to inject (e.g. `category`). */
    param: z.string().min(1),
    /**
     * Template string with a literal `{}` placeholder for the facet value.
     * The adapter coerces non-string values via `String(value)` before
     * substitution.
     */
    template: z.string().min(1),
    /** Explicit list of facet values to sweep. */
    values: z.array(z.union([z.string(), z.number()])).min(1),
  })
  .superRefine((value, ctx) => {
    if (!value.template.includes("{}")) {
      ctx.addIssue({
        code: "custom",
        path: ["template"],
        message: "template must contain '{}' placeholder",
      });
    }
  });
export type SourceFacetEnum = z.infer<typeof SourceFacetEnumSchema>;

export const SourceFacetSchema = z.discriminatedUnion("type", [
  SourceFacetRangeSchema,
  SourceFacetEnumSchema,
]);
export type SourceFacet = z.infer<typeof SourceFacetSchema>;

/**
 * Map of facet-name → facet-spec. In Phase 1 the adapter enforces a
 * single entry at runtime (multi-facet is deferred to a future ADR), but
 * the schema accepts the record shape so future multi-facet support does
 * not require a schema break.
 */
export const SourceFacetsSchema = z.record(z.string().min(1), SourceFacetSchema);
export type SourceFacets = z.infer<typeof SourceFacetsSchema>;

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
    // `http` / `pagination` / `jsonSelectors` are consulted only by the
    // `json-api` adapter (ADR-0012). Marked optional so existing source YAMLs
    // and other kinds parse unchanged. The `jsonSelectors` name disambiguates
    // from the css-selector `selectors` field that html / html-js use.
    http: SourceHttpOptionsSchema.optional(),
    pagination: SourcePaginationSchema.optional(),
    jsonSelectors: SourceJsonApiSelectorsSchema.optional(),
    // Facet sweep recipe extension (ADR-0017). Independent of
    // `pagination`: `facets` is the outer "data slice" axis, `pagination`
    // is the inner per-request page traversal. Only consulted by the
    // `json-api` adapter. Single-facet only in Phase 1 — multi-facet is
    // schema-allowed for forward-compat but the adapter throws at runtime.
    facets: SourceFacetsSchema.optional(),
    // `trustLevel` defaults to `"untrusted"` so existing source YAMLs (which
    // omit the field entirely) keep their current treatment. Per ADR-0009 M4
    // this is schema-only; policy branches that read `trustLevel` arrive in a
    // separate sub-issue.
    trustLevel: TrustLevelSchema.default("untrusted"),
    // `triagePolicy` is the per-source triage configuration introduced by
    // ADR-0018. Optional: existing source YAMLs without the block remain
    // valid and `radar triage` (PR-3) skips sources missing a policy. PR-1
    // is schema-only — the adapter (PR-2) and CLI (PR-3) consume this in
    // later PRs.
    triagePolicy: SourceTriagePolicySchema.optional(),
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
    if (value.kind === "json-api") {
      // `jsonSelectors` is now optional — when omitted the adapter relies on
      // its default selector chain (ADR-0012 §D2 / #174). Most "simple"
      // page-based APIs work with just `pagination` set; complex shapes
      // (AWS What's New, nested fields) still need explicit selectors.
      if (value.pagination === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["pagination"],
          message: "pagination is required when kind is 'json-api'",
        });
      }
    }
  });
export type Source = z.infer<typeof SourceSchema>;
