import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { type RecipeFile, RecipeFileSchema } from "../schemas/recipe.js";

/**
 * Recipe loader and CLI-args merger for `radar source recipes` /
 * `radar source add --recipe <name>` (ADR-0012 §D3, strategy A — リポ同梱).
 *
 * Design notes:
 *
 * - Recipes live in `recipes/*.yaml` at the package root and are bundled
 *   into npm publish via the package.json `files` allowlist plus a copy
 *   step in `scripts/copy-skills.mjs` (`recipes/` → `dist/recipes/`). The
 *   resolver tries the compiled location first, then falls back to the
 *   source tree (used by the test suite and `pnpm test` runs that have
 *   not built `dist/` yet).
 *
 * - The directory is allowed to be empty (#178 adds the actual bundled
 *   recipes). When the directory is missing entirely the loader behaves
 *   the same as "no recipes" — the bundle is optional at the schema
 *   level. The CLI surfaces a friendly "no recipes" message instead of
 *   an error in that case.
 *
 * - Each recipe is independently parse-and-validate so one malformed
 *   YAML does not prevent the rest from being listed. `listRecipes`
 *   returns per-recipe `error` strings; `loadRecipe(name)` throws so
 *   `--recipe <name>` can hard-fail at `source add` time.
 *
 * - The recipe's identifier ( `--recipe <name>` match key) is the YAML
 *   filename stem. There is no inner "name" field that doubles as the
 *   match key — recipe authors rename the file to rename the recipe.
 *   `RecipeFile.name` is the *display name* (mirrors `Source.name`).
 */

/** A recipe loaded from disk, paired with its filename-derived identifier. */
export interface LoadedRecipe {
  /** Filename stem (e.g. `aws-whats-new` for `aws-whats-new.yaml`). */
  name: string;
  /** Absolute path of the recipe YAML, useful for error messages. */
  path: string;
  recipe: RecipeFile;
}

/** Entry returned by `listRecipes`, including malformed recipes (with `error`). */
export interface RecipeListEntry {
  name: string;
  path: string;
  /** Parsed recipe, or `null` when this entry failed to load (see `error`). */
  recipe: RecipeFile | null;
  /** Human-readable error string when the entry could not be loaded. */
  error?: string;
}

/** Options for the loader/lister to override the recipes directory (used by tests). */
export interface RecipeLoaderOptions {
  recipesRoot?: string;
}

/**
 * Resolve the directory holding the bundled recipes.
 *
 * Compiled layout (npm install): `dist/core/recipes.js` → `../recipes`.
 * Source layout (tests / `pnpm test`): `src/core/recipes.ts` → `../../recipes`.
 *
 * We probe the compiled location first because that is the path users
 * hit at runtime. Both paths can be present during local development
 * (after `pnpm run build`); preferring compiled keeps the source tree
 * from being the active asset directory by accident.
 */
export async function resolveRecipesRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, "../recipes");
  if (await pathExists(compiled)) {
    return compiled;
  }
  // Source layout fallback. We walk two levels up from src/core/ to find
  // the package root, then descend into `recipes/`.
  return resolve(here, "../../recipes");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all bundled recipes by reading every `*.yaml` file in the recipes
 * directory.
 *
 * Behaviour:
 *
 * - Missing recipes directory → returns `[]` (treated as "no recipes",
 *   not an error). This matches the bootstrap state where #178 has not
 *   yet shipped the actual recipe files.
 * - Each `.yaml` is independently parsed and Zod-validated. Failures are
 *   captured in the per-entry `error` field so partial corruption never
 *   prevents the rest from rendering.
 * - Entries are sorted by `name` for deterministic output (tests rely on
 *   this; users get a stable display order).
 */
export async function listRecipes(opts: RecipeLoaderOptions = {}): Promise<RecipeListEntry[]> {
  const root = opts.recipesRoot ?? (await resolveRecipesRoot());
  if (!(await pathExists(root))) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  // `.gitkeep` (or any other dotfile) must not be picked up as a recipe;
  // the `*.yaml` glob is enforced by suffix rather than a separate
  // exclude list.
  const yamlFiles = entries.filter((f) => f.endsWith(".yaml")).sort();

  const results: RecipeListEntry[] = [];
  for (const filename of yamlFiles) {
    const path = join(root, filename);
    const name = filename.slice(0, -".yaml".length);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      results.push({
        name,
        path,
        recipe: null,
        error: `failed to read: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      results.push({
        name,
        path,
        recipe: null,
        error: `invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    const result = RecipeFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      results.push({
        name,
        path,
        recipe: null,
        error: `schema validation failed: ${issues}`,
      });
      continue;
    }
    results.push({ name, path, recipe: result.data });
  }
  return results;
}

/**
 * Load a single recipe by its filename stem (e.g. `aws-whats-new`).
 *
 * Throws on:
 *
 * - missing recipes directory (the bundle is absent)
 * - unknown recipe name (the file does not exist)
 * - malformed YAML or Zod-schema violation
 *
 * The error messages are user-facing — `source add --recipe` surfaces
 * them via the CLI `error()` sink without further wrapping.
 */
export async function loadRecipe(
  name: string,
  opts: RecipeLoaderOptions = {},
): Promise<LoadedRecipe> {
  // Reject path-separator / traversal characters defensively. `--recipe`
  // is positional CLI input and could be copied from arbitrary sources;
  // the same posture as `isSafeSourceId` keeps the lookup confined to
  // the recipes directory.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
    throw new Error(`invalid recipe name '${name}' (must match [A-Za-z0-9][A-Za-z0-9._-]*)`);
  }

  const root = opts.recipesRoot ?? (await resolveRecipesRoot());
  if (!(await pathExists(root))) {
    throw new Error(
      `no bundled recipes available (recipes/ not found at ${root}); recipe '${name}' cannot be resolved`,
    );
  }

  const path = join(root, `${name}.yaml`);
  if (!(await pathExists(path))) {
    // Surface available names so the user can self-correct without having
    // to run a second command. List failures are swallowed here (best
    // effort) so the primary error message is the one the user sees.
    let available: string[] = [];
    try {
      const all = await listRecipes({ recipesRoot: root });
      available = all.map((r) => r.name);
    } catch {
      // ignore — we already have the primary error to report
    }
    const hint = available.length === 0 ? "" : ` (available: ${available.join(", ")})`;
    throw new Error(`recipe '${name}' not found${hint}`);
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(
      `failed to read recipe '${name}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(
      `invalid YAML in recipe '${name}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const result = RecipeFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`recipe '${name}' failed schema validation: ${issues}`);
  }

  return { name, path, recipe: result.data };
}

/**
 * CLI overrides applied on top of a recipe when generating a Source.
 *
 * The whitelist is intentionally narrow:
 *
 * - `id` (required) — recipes never carry an `id`; the caller picks one
 *   per workspace
 * - `name` (display name) — useful when a single recipe is applied
 *   multiple times to differentiate, or to localize
 * - `tags` — workspace-level taxonomy that varies per install
 * - `filters.keywords` / `filters.excludeKeywords` — the only fields a
 *   user is reliably expected to override; "what counts as a hit" is
 *   per-workspace
 *
 * Other fields (`pagination`, `jsonSelectors`, `selectors`, `js`,
 * `http`, `url`, `kind`, `trustLevel`) are NOT overridable from the
 * CLI. Recipe authors own these "structural" fields. Users edit the
 * generated `sources/<id>.yaml` if they need to deviate further.
 */
export interface RecipeOverrides {
  /** Required — the source id chosen by the caller. */
  id: string;
  /** Optional override for `Source.name` (display name). */
  name?: string;
  /** Optional override for `Source.tags` (replaces, does not merge). */
  tags?: string[];
  /** Optional override for `filters.keywords` (replaces, does not merge). */
  keywords?: string[];
  /** Optional override for `filters.excludeKeywords` (replaces, does not merge). */
  excludeKeywords?: string[];
}

/**
 * Merge a recipe with CLI overrides to produce a plain object suitable
 * for `SourceSchema.safeParse`.
 *
 * Override semantics: each field is *replaced* (not merged) when the
 * override is present. This mirrors `source add` flag semantics
 * (`--keywords a,b` replaces, never appends) and keeps the mental model
 * uniform across `add` and `add --recipe`.
 *
 * `description` from the recipe is dropped — it is recipe metadata,
 * not Source metadata. Strip it explicitly so the generated YAML does
 * not carry a stray field that fails downstream schema validation.
 */
export function mergeRecipeWithOverrides(
  recipe: RecipeFile,
  overrides: RecipeOverrides,
): Record<string, unknown> {
  // Build the candidate as a fresh object so the recipe object on disk
  // is not mutated and we get control over field ordering in the output
  // YAML (id first → kind → url → ...).
  const candidate: Record<string, unknown> = {
    id: overrides.id,
    kind: recipe.kind,
    url: recipe.url,
  };

  // Display name: caller override wins, then recipe.name, then nothing.
  if (overrides.name !== undefined) {
    candidate.name = overrides.name;
  } else if (recipe.name !== undefined) {
    candidate.name = recipe.name;
  }

  // Tags: override replaces; otherwise inherit recipe tags (which defaults
  // to []). Emit only when non-empty so the YAML stays minimal for the
  // common case "no tags in either place".
  const tags = overrides.tags ?? recipe.tags;
  if (tags.length > 0) {
    candidate.tags = tags;
  }

  // Filters: override the include/exclude keyword arrays; preserve the
  // recipe's other filter knobs (matchMode / matchFields / caseSensitive)
  // because those reflect adapter-specific tuning that the recipe author
  // already picked.
  const mergedFilters = {
    ...recipe.filters,
    keywords: overrides.keywords ?? recipe.filters.keywords,
    excludeKeywords: overrides.excludeKeywords ?? recipe.filters.excludeKeywords,
  };
  candidate.filters = mergedFilters;

  // Structural fields that the recipe owns. Drop undefined entries to
  // keep the generated YAML free of explicit nulls.
  if (recipe.selectors !== undefined) candidate.selectors = recipe.selectors;
  if (recipe.js !== undefined) candidate.js = recipe.js;
  if (recipe.http !== undefined) candidate.http = recipe.http;
  if (recipe.pagination !== undefined) candidate.pagination = recipe.pagination;
  if (recipe.jsonSelectors !== undefined) candidate.jsonSelectors = recipe.jsonSelectors;
  // Facet sweep (ADR-0017). Recipe-only structural field — caller cannot
  // override via flags in Phase 1 (see `printAddHelp` for the rationale).
  if (recipe.facets !== undefined) candidate.facets = recipe.facets;

  candidate.trustLevel = recipe.trustLevel;

  return candidate;
}
