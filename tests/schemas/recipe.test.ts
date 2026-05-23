import { describe, expect, it } from "vitest";
import { RecipeFileSchema } from "../../src/schemas/recipe.js";

/**
 * Recipe schema tests focused on the ADR-0018 `triagePolicy` extension.
 *
 * The broader recipe-shape contract is exercised end-to-end by
 * `tests/recipes/bundled.test.ts` (every shipped recipe in `recipes/` is
 * round-tripped through `RecipeFileSchema` and `mergeRecipeWithOverrides`).
 * The cases here pin the ADR-0018 add-on so a regression in the optional
 * triagePolicy plumbing surfaces at unit-test time, not bundled-recipe
 * integration time.
 */

const MIN_RECIPE = {
  kind: "rss" as const,
  url: "https://example.com/feed.xml",
};

describe("schemas/recipe — triagePolicy (ADR-0018 §W3)", () => {
  it("parses a recipe without triagePolicy (backward compat with bundled recipes)", () => {
    // Every bundled recipe shipped before ADR-0018 omits `triagePolicy:` —
    // making the field optional is the contract that keeps PR-1 a pure
    // additive change. If this default ever flips to required, bundled
    // recipe parsing breaks at `radar source recipes` time.
    const result = RecipeFileSchema.parse(MIN_RECIPE);
    expect(result.triagePolicy).toBeUndefined();
    expect(result.trustLevel).toBe("untrusted");
  });

  it("accepts a recipe with a default triagePolicy bundled in", () => {
    const result = RecipeFileSchema.parse({
      ...MIN_RECIPE,
      triagePolicy: {
        agent: "gemini-cli",
        confidenceThreshold: 0.75,
        rules: "新サービス GA → research。リージョン拡張 → dismiss。",
      },
    });
    expect(result.triagePolicy?.agent).toBe("gemini-cli");
    expect(result.triagePolicy?.confidenceThreshold).toBe(0.75);
    expect(result.triagePolicy?.rules).toContain("research");
  });

  it("applies the policy's own confidenceThreshold default (0.7) when omitted", () => {
    // The recipe-level default chain delegates to SourceTriagePolicySchema's
    // own `.default(0.7)`. Confirm the default propagates so recipe authors
    // can write just `{ agent, rules }` and still get the recommended
    // threshold.
    const result = RecipeFileSchema.parse({
      ...MIN_RECIPE,
      triagePolicy: {
        agent: "claude-code",
        rules: "Anthropic news は全件 research。",
      },
    });
    expect(result.triagePolicy?.confidenceThreshold).toBe(0.7);
  });

  it("rejects a recipe whose triagePolicy has an empty rules string", () => {
    const result = RecipeFileSchema.safeParse({
      ...MIN_RECIPE,
      triagePolicy: {
        agent: "gemini-cli",
        rules: "",
      },
    });
    expect(result.success).toBe(false);
  });
});
