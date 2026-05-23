import { z } from "zod";
import {
  SourceFacetsSchema,
  SourceFiltersSchema,
  SourceHttpOptionsSchema,
  SourceJsOptionsSchema,
  SourceJsonApiSelectorsSchema,
  SourceKindSchema,
  SourcePaginationSchema,
  SourceSelectorsSchema,
  SourceTriagePolicySchema,
  TrustLevelSchema,
} from "./source.js";

/**
 * Schema for a bundled recipe YAML file (ADR-0012 §D3, strategy A —
 * "リポ同梱").
 *
 * Recipes are partial-Source templates that live in `recipes/*.yaml` and
 * are applied via `radar source add <id> --recipe <name>`. The recipe
 * supplies the heavy lifting fields (`kind`, `url`, `pagination`,
 * `jsonSelectors`, ...) while the caller picks an `id` and may override a
 * small whitelist of "ergonomic" fields (`name` / `tags` / `filters`).
 *
 * The schema is intentionally a near-mirror of `SourceSchema` minus `id` —
 * the id is supplied by the caller at `source add` time, never by the
 * recipe itself. `id` baked into a recipe would conflict with user-chosen
 * ids in shared workspaces and forces a per-install rename ritual that
 * defeats the whole "one-liner add" promise.
 *
 * `name` here is the recipe's *display name*, mirroring `Source.name`.
 * The recipe's identifier — what `--recipe <name>` matches against — is
 * the YAML filename stem, never a YAML field. This keeps the recipe
 * authoring contract simple (rename the file = rename the recipe) and
 * avoids the foot-gun where a recipe's filename and inner `name` field
 * diverge.
 *
 * `description` is recipe-only metadata surfaced by `radar source recipes`
 * for discovery. It does NOT propagate to the generated source YAML.
 */
export const RecipeFileSchema = z.object({
  /** Display name (mirrors `Source.name`). Optional. */
  name: z.string().optional(),
  /**
   * One-line description shown by `radar source recipes`. Recipe-only
   * metadata — never written to the generated `sources/<id>.yaml`.
   */
  description: z.string().optional(),
  kind: SourceKindSchema,
  url: z.string().min(1),
  tags: z.array(z.string()).default([]),
  filters: SourceFiltersSchema.default({
    keywords: [],
    excludeKeywords: [],
    matchMode: "word",
    matchFields: ["title", "summary"],
    caseSensitive: false,
  }),
  selectors: SourceSelectorsSchema.optional(),
  js: SourceJsOptionsSchema.optional(),
  http: SourceHttpOptionsSchema.optional(),
  pagination: SourcePaginationSchema.optional(),
  jsonSelectors: SourceJsonApiSelectorsSchema.optional(),
  // Facet sweep recipe extension (ADR-0017). Optional so existing recipes
  // without `facets:` keep working unchanged.
  facets: SourceFacetsSchema.optional(),
  trustLevel: TrustLevelSchema.default("untrusted"),
  /**
   * Default triage policy bundled with the recipe (ADR-0018 §W3). When
   * `radar source add --recipe <name>` materializes a source from this
   * recipe, the policy propagates onto `sources/<id>.yaml > triagePolicy:`
   * so the user gets a sensible default without authoring rules by hand.
   * Optional: existing bundled recipes (PR #229 / #232) ship without
   * `triagePolicy:` and continue to validate.
   */
  triagePolicy: SourceTriagePolicySchema.optional(),
});

export type RecipeFile = z.infer<typeof RecipeFileSchema>;
