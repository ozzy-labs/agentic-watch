import { describe, expect, it } from "vitest";
import { listRecipes, mergeRecipeWithOverrides } from "../../src/core/recipes.js";
import { SourceSchema } from "../../src/schemas/source.js";

/**
 * Bundled-recipe contract tests (#178 / ADR-0012 §D3 strategy A).
 *
 * These tests run against the actual `recipes/*.yaml` files that ship with
 * the package, not synthetic fixtures. The goal is to catch:
 *
 *   1. A bundled recipe failing the `RecipeFileSchema` (Zod). This would
 *      otherwise surface only at `radar source recipes` time on the user's
 *      machine — far too late.
 *   2. URL / pagination drift that puts a recipe outside the ADR-approved
 *      envelope (HTTPS only, supported pagination strategy, sensible
 *      `maxPages` cap).
 *   3. A recipe whose generated Source fails `SourceSchema` after merging
 *      with caller-supplied `id`. `mergeRecipeWithOverrides` is the entry
 *      point the CLI uses, so we round-trip every bundled recipe through it
 *      with a placeholder id.
 *
 * Whenever a new bundled recipe is added, no test code change is required —
 * the suite picks it up via `listRecipes()` and applies the contract checks.
 */
describe("bundled recipes :: schema", () => {
  it("loads every recipe in recipes/ without per-entry errors", async () => {
    const entries = await listRecipes();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.error, `recipe '${entry.name}' should load cleanly`).toBeUndefined();
      expect(entry.recipe, `recipe '${entry.name}' should parse to a RecipeFile`).not.toBeNull();
    }
  });

  it("uses an https URL for every bundled recipe (ADR-0012 §D5b host hardening)", async () => {
    const entries = await listRecipes();
    for (const entry of entries) {
      if (!entry.recipe) continue;
      // The `kind: npm-registry` adapter accepts bare package names; every
      // other kind requires a fully-qualified https URL. We do not yet bundle
      // any `npm-registry` recipes, but guarding here keeps the test robust
      // if one ever lands.
      if (entry.recipe.kind === "npm-registry") continue;
      expect(
        entry.recipe.url.startsWith("https://"),
        `recipe '${entry.name}' url must be https (got: ${entry.recipe.url})`,
      ).toBe(true);
    }
  });

  it("declares an ADR-approved pagination strategy for kind: json-api recipes", async () => {
    // ADR-0012 §D2 enumerates the five supported pagination types plus
    // `none`. The Zod enum on `SourcePaginationSchema` already enforces
    // this, but we mirror the check explicitly so a future enum widening
    // does not silently bypass review.
    const allowed = new Set(["page", "offset", "cursor", "link-header", "token", "none"]);
    const entries = await listRecipes();
    for (const entry of entries) {
      if (entry.recipe?.kind !== "json-api") continue;
      const strategy = entry.recipe.pagination?.type;
      expect(
        strategy && allowed.has(strategy),
        `recipe '${entry.name}' must declare a supported pagination strategy (got: ${strategy})`,
      ).toBe(true);
    }
  });

  it("keeps pagination.maxPages within a sane envelope (no runaway recipes)", async () => {
    // ADR-0012 §D5 defense-in-depth: a malformed `maxPages: 9999` would let
    // a single recipe issue ~10⁴ requests. Cap bundled recipes at 100 —
    // the facet-sweep approach (ADR-0017) means individual recipe slices
    // are now per-facet caps rather than full-history caps, so values like
    // 250 (PR #232's full-history setting) are no longer needed. AWS
    // What's New now uses `maxPages: 30` (per-year cap, ≤24 pages needed
    // for the largest year). dev.to uses 10. Leaving 100 as the ceiling
    // gives future bundled recipes plenty of headroom without re-opening
    // the runaway-recipe risk.
    const entries = await listRecipes();
    for (const entry of entries) {
      const max = entry.recipe?.pagination?.maxPages;
      if (max === undefined) continue;
      expect(
        max,
        `recipe '${entry.name}' pagination.maxPages=${max} exceeds the bundled-recipe cap (100)`,
      ).toBeLessThanOrEqual(100);
      expect(max).toBeGreaterThan(0);
    }
  });

  it("defaults trustLevel to 'untrusted' (no bundled recipe opts into trusted)", async () => {
    // ADR-0009 §A: every Source ingested from external APIs is untrusted.
    // Bundled recipes flow through the same boundary as user-written ones,
    // so `trustLevel: trusted` would be a notable policy deviation that
    // belongs in its own review, not slipped in via a recipe edit.
    const entries = await listRecipes();
    for (const entry of entries) {
      expect(entry.recipe?.trustLevel).toBe("untrusted");
    }
  });

  it("produces a SourceSchema-valid Source when merged with a placeholder id", async () => {
    const entries = await listRecipes();
    for (const entry of entries) {
      if (!entry.recipe) continue;
      const merged = mergeRecipeWithOverrides(entry.recipe, {
        id: `bundled-test-${entry.name}`,
      });
      const result = SourceSchema.safeParse(merged);
      expect(
        result.success,
        `recipe '${entry.name}' fails SourceSchema after merge: ${
          result.success
            ? ""
            : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        }`,
      ).toBe(true);
    }
  });
});

describe("bundled recipes :: documented bundle (Phase 1 set)", () => {
  it("ships the AWS What's New and dev.to recipes documented in ADR-0012", async () => {
    // The exact set of bundled recipes is permitted to grow over time
    // (#178 adds the Phase 1 trio; later issues may extend it). We assert
    // only the lower bound: the two recipes documented in ADR-0012 §D3
    // and #178 acceptance criteria MUST be present.
    const entries = await listRecipes();
    const names = new Set(entries.map((e) => e.name));
    expect(names.has("aws-whats-new")).toBe(true);
    expect(names.has("dev-to")).toBe(true);
  });

  it("aws-whats-new uses page-based pagination with a totalPath hint", async () => {
    const entries = await listRecipes();
    const aws = entries.find((e) => e.name === "aws-whats-new");
    expect(aws?.recipe?.kind).toBe("json-api");
    expect(aws?.recipe?.pagination?.type).toBe("page");
    // `totalPath` lets `--backfill` short-circuit once the AWS-reported
    // total is reached. Drift on this field would silently disable the
    // optimization, so we pin it.
    expect(aws?.recipe?.pagination?.totalPath).toBe("$.metadata.totalHits");
    // The AWS response wraps items inside `{item: ...}`; the dereferencing
    // selector is what differentiates this from the default chain.
    expect(aws?.recipe?.jsonSelectors?.items).toBe("$.items[*].item");
    // `headlineUrl` is a relative path; the adapter resolves it against
    // `linkBase` so `Item.url` validates. Pinning the explicit base here
    // protects against accidental edits that would silently drop every
    // AWS item again (#204).
    expect(aws?.recipe?.jsonSelectors?.linkBase).toBe("https://aws.amazon.com");
  });

  it("aws-whats-new declares a year facet sweep (ADR-0017)", async () => {
    // The year facet circumvents the AWS dirs API's 10,000-item offset
    // cap (empirically discovered: `(page + 1) * size <= 10000` regardless
    // of pageSize). Without this, ~1,800 of the totalHits ~21,834 items
    // would be unreachable. Pinning the spec shape protects against
    // accidental edits that would silently re-introduce the gap.
    const entries = await listRecipes();
    const aws = entries.find((e) => e.name === "aws-whats-new");
    const year = aws?.recipe?.facets?.year;
    expect(year, "aws-whats-new must declare facets.year").toBeDefined();
    expect(year?.type).toBe("range");
    // Template must contain the `{}` placeholder (Zod refine would have
    // rejected otherwise, but pin the contract here too).
    expect(year?.template).toContain("{}");
    expect(year?.param).toBe("tags.id");
  });

  it("dev-to relies on the default selector chain (no jsonSelectors block)", async () => {
    const entries = await listRecipes();
    const devto = entries.find((e) => e.name === "dev-to");
    expect(devto?.recipe?.kind).toBe("json-api");
    expect(devto?.recipe?.pagination?.type).toBe("page");
    // Omitting `jsonSelectors` entirely is what exercises the
    // default-selector-chain path in `json-api.ts`. If a future edit adds
    // explicit selectors back, this assertion will surface the change in
    // review.
    expect(devto?.recipe?.jsonSelectors).toBeUndefined();
  });
});
