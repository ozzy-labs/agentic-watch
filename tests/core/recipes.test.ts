import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  listRecipes,
  loadRecipe,
  mergeRecipeWithOverrides,
  resolveRecipesRoot,
} from "../../src/core/recipes.js";
import type { RecipeFile } from "../../src/schemas/recipe.js";
import { SourceSchema } from "../../src/schemas/source.js";

/**
 * Helper that materializes a recipes directory in a tmpdir and returns the
 * absolute path. The directory itself is fresh per test so cross-test
 * leakage cannot happen even when individual tests forget to clean up.
 */
async function makeRecipesDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "feedradar-recipes-"));
  await mkdir(root, { recursive: true });
  return root;
}

async function writeRecipe(root: string, name: string, body: string): Promise<void> {
  await writeFile(join(root, `${name}.yaml`), body, "utf8");
}

describe("core/recipes :: resolveRecipesRoot", () => {
  it("resolves to a recipes/ directory under the package layout", async () => {
    // Production callers do not pass `recipesRoot`; the resolver walks
    // up from this module's URL and probes the bundled dir. We do not
    // assert the exact path (it differs between dev and npm install),
    // only that it ends with `/recipes` so refactors of the resolver
    // are caught here.
    const root = await resolveRecipesRoot();
    expect(root).toMatch(/[\\/]recipes$/);
  });
});

describe("core/recipes :: listRecipes", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeRecipesDir();
  });

  it("returns [] for an empty recipes directory (bootstrap state)", async () => {
    const result = await listRecipes({ recipesRoot: root });
    expect(result).toEqual([]);
  });

  it("returns [] when the recipes directory does not exist", async () => {
    const result = await listRecipes({
      recipesRoot: join(root, "does-not-exist"),
    });
    expect(result).toEqual([]);
  });

  it("lists valid recipes sorted by name", async () => {
    await writeRecipe(
      root,
      "zebra",
      "kind: rss\nurl: https://z.example.com/rss.xml\ndescription: Zebra blog\n",
    );
    await writeRecipe(
      root,
      "alpha",
      "kind: rss\nurl: https://a.example.com/rss.xml\ndescription: Alpha blog\n",
    );

    const result = await listRecipes({ recipesRoot: root });
    expect(result.map((r) => r.name)).toEqual(["alpha", "zebra"]);
    expect(result[0]?.recipe?.kind).toBe("rss");
    expect(result[0]?.error).toBeUndefined();
  });

  it("captures invalid YAML as a per-entry error without breaking other entries", async () => {
    await writeRecipe(root, "good", "kind: rss\nurl: https://good.example.com/rss.xml\n");
    // Bad YAML: unclosed quote on the second line.
    await writeRecipe(root, "broken", "kind: rss\nurl: '");

    const result = await listRecipes({ recipesRoot: root });
    expect(result).toHaveLength(2);
    const good = result.find((r) => r.name === "good");
    const broken = result.find((r) => r.name === "broken");
    expect(good?.recipe?.kind).toBe("rss");
    expect(good?.error).toBeUndefined();
    expect(broken?.recipe).toBeNull();
    expect(broken?.error).toMatch(/invalid YAML/);
  });

  it("captures Zod validation failures as a per-entry error", async () => {
    // Missing required `url` field — Zod should reject.
    await writeRecipe(root, "incomplete", "kind: rss\n");

    const result = await listRecipes({ recipesRoot: root });
    expect(result).toHaveLength(1);
    expect(result[0]?.recipe).toBeNull();
    expect(result[0]?.error).toMatch(/schema validation failed/);
  });

  it("ignores non-yaml files (e.g. .gitkeep)", async () => {
    await writeFile(join(root, ".gitkeep"), "", "utf8");
    await writeFile(join(root, "notes.md"), "# notes", "utf8");
    await writeRecipe(root, "real", "kind: rss\nurl: https://example.com/feed\n");

    const result = await listRecipes({ recipesRoot: root });
    expect(result.map((r) => r.name)).toEqual(["real"]);
  });

  it("uses the resolved package recipes/ dir when no recipesRoot opt is given", async () => {
    // The package ships an empty recipes/ (#178 adds the actual files).
    // Calling listRecipes() with no opts must therefore return [] without
    // throwing — exercises the resolveRecipesRoot() fallback path.
    const result = await listRecipes();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("core/recipes :: loadRecipe", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeRecipesDir();
  });

  it("loads a valid recipe by name", async () => {
    await writeRecipe(
      root,
      "aws-whats-new",
      `kind: json-api
url: https://aws.amazon.com/api/dirs/items/search
description: AWS What's New feed
pagination:
  type: page
  param: page
  start: 0
  pageSize: 100
  pageSizeParam: size
  maxPages: 200
`,
    );

    const loaded = await loadRecipe("aws-whats-new", { recipesRoot: root });
    expect(loaded.name).toBe("aws-whats-new");
    expect(loaded.recipe.kind).toBe("json-api");
    expect(loaded.recipe.pagination?.maxPages).toBe(200);
  });

  it("throws when the recipe does not exist, listing available names", async () => {
    await writeRecipe(root, "alpha", "kind: rss\nurl: https://a.example/feed\n");
    await writeRecipe(root, "beta", "kind: rss\nurl: https://b.example/feed\n");

    await expect(loadRecipe("ghost", { recipesRoot: root })).rejects.toThrow(
      /recipe 'ghost' not found.*alpha.*beta/,
    );
  });

  it("throws when the recipe YAML is invalid", async () => {
    // Quote opened on line 2 is never closed — yaml parser raises.
    await writeRecipe(root, "broken", "kind: rss\nurl: '");

    await expect(loadRecipe("broken", { recipesRoot: root })).rejects.toThrow(
      /invalid YAML in recipe 'broken'/,
    );
  });

  it("throws when the recipe fails schema validation", async () => {
    // `kind: not-a-real-kind` is not in the enum.
    await writeRecipe(root, "bogus", "kind: not-a-real-kind\nurl: https://x.example\n");

    await expect(loadRecipe("bogus", { recipesRoot: root })).rejects.toThrow(
      /recipe 'bogus' failed schema validation/,
    );
  });

  it("rejects unsafe recipe names defensively (traversal characters)", async () => {
    await expect(loadRecipe("../escape", { recipesRoot: root })).rejects.toThrow(
      /invalid recipe name/,
    );
    await expect(loadRecipe("a/b", { recipesRoot: root })).rejects.toThrow(/invalid recipe name/);
  });

  it("throws when the recipes directory itself is absent", async () => {
    await expect(
      loadRecipe("anything", { recipesRoot: join(root, "no-such-dir") }),
    ).rejects.toThrow(/no bundled recipes available/);
  });

  it("emits 'not found' with no `available:` hint when the recipes dir is empty", async () => {
    // Different from the absent-dir case: the dir exists but holds no
    // .yaml files. The error message should not include "(available: ...)"
    // because there is nothing to list.
    await expect(loadRecipe("ghost", { recipesRoot: root })).rejects.toThrow(
      /recipe 'ghost' not found$/,
    );
  });

  it("rejects an empty recipe name", async () => {
    await expect(loadRecipe("", { recipesRoot: root })).rejects.toThrow(/invalid recipe name/);
  });
});

describe("core/recipes :: mergeRecipeWithOverrides", () => {
  function baseRecipe(): RecipeFile {
    return {
      kind: "json-api",
      url: "https://dev.to/api/articles",
      description: "dev.to articles feed",
      name: "Dev.to",
      tags: ["blog"],
      filters: {
        keywords: ["rust"],
        excludeKeywords: [],
        matchMode: "word",
        matchFields: ["title", "summary"],
        caseSensitive: false,
      },
      pagination: { type: "page", maxPages: 20 },
      trustLevel: "untrusted",
    };
  }

  it("inherits recipe defaults when only id is overridden", () => {
    const merged = mergeRecipeWithOverrides(baseRecipe(), { id: "devto" });
    // Round-trip through SourceSchema to confirm the merged candidate is
    // a valid Source — this is the same validation the CLI applies.
    const validated = SourceSchema.safeParse(merged);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    expect(validated.data.id).toBe("devto");
    expect(validated.data.kind).toBe("json-api");
    expect(validated.data.url).toBe("https://dev.to/api/articles");
    expect(validated.data.name).toBe("Dev.to");
    expect(validated.data.tags).toEqual(["blog"]);
    expect(validated.data.filters.keywords).toEqual(["rust"]);
  });

  it("overrides name / tags / keywords / excludeKeywords", () => {
    const merged = mergeRecipeWithOverrides(baseRecipe(), {
      id: "devto-rust",
      name: "Dev.to (Rust)",
      tags: ["rust", "lang"],
      keywords: ["Rust", "tokio"],
      excludeKeywords: ["draft"],
    });
    const validated = SourceSchema.safeParse(merged);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    expect(validated.data.name).toBe("Dev.to (Rust)");
    expect(validated.data.tags).toEqual(["rust", "lang"]);
    expect(validated.data.filters.keywords).toEqual(["Rust", "tokio"]);
    expect(validated.data.filters.excludeKeywords).toEqual(["draft"]);
  });

  it("preserves recipe-author filter knobs (matchMode/matchFields/caseSensitive) when overriding keywords only", () => {
    const recipe: RecipeFile = {
      ...baseRecipe(),
      filters: {
        keywords: ["default"],
        excludeKeywords: [],
        matchMode: "regex",
        matchFields: ["title", "body"],
        caseSensitive: true,
      },
    };
    const merged = mergeRecipeWithOverrides(recipe, {
      id: "x",
      keywords: ["new-kw"],
    });
    const validated = SourceSchema.safeParse(merged);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    expect(validated.data.filters.keywords).toEqual(["new-kw"]);
    expect(validated.data.filters.matchMode).toBe("regex");
    expect(validated.data.filters.matchFields).toEqual(["title", "body"]);
    expect(validated.data.filters.caseSensitive).toBe(true);
  });

  it("does not propagate recipe.description into the generated Source", () => {
    const merged = mergeRecipeWithOverrides(baseRecipe(), { id: "devto" });
    expect("description" in merged).toBe(false);
  });

  it("omits tags entirely when both recipe and override are empty", () => {
    const recipe: RecipeFile = { ...baseRecipe(), tags: [] };
    const merged = mergeRecipeWithOverrides(recipe, { id: "devto" });
    expect("tags" in merged).toBe(false);
  });

  it("propagates structural fields the recipe owns (pagination/jsonSelectors/etc.)", () => {
    const recipe: RecipeFile = {
      ...baseRecipe(),
      jsonSelectors: { items: "$.posts[*]", title: "$.headline" },
    };
    const merged = mergeRecipeWithOverrides(recipe, { id: "x" });
    const validated = SourceSchema.safeParse(merged);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    expect(validated.data.jsonSelectors).toEqual({
      items: "$.posts[*]",
      title: "$.headline",
    });
    expect(validated.data.pagination?.type).toBe("page");
  });

  it("falls back to overrides.name when recipe.name is undefined", () => {
    const recipe: RecipeFile = { ...baseRecipe(), name: undefined };
    const merged = mergeRecipeWithOverrides(recipe, {
      id: "devto",
      name: "Custom",
    });
    expect(merged.name).toBe("Custom");
  });

  it("emits no `name` field when neither recipe nor override supplies one", () => {
    const recipe: RecipeFile = { ...baseRecipe(), name: undefined };
    const merged = mergeRecipeWithOverrides(recipe, { id: "devto" });
    expect("name" in merged).toBe(false);
  });
});
