#!/usr/bin/env node
/**
 * Recipes smoke test (#178 / ADR-0012 §D3).
 *
 * Walks every bundled recipe (`recipes/*.yaml`) and exercises a single
 * page-0 fetch + parse against the live upstream API. Emits GitHub
 * Actions annotations (`::warning::` / `::error::`) on failure but
 * never aborts the run early — every recipe is probed so a single
 * site outage does not mask the rest.
 *
 * Design choices:
 *
 *   - **Warning, not error**: per ADR-0012 §D3 the smoke job is a
 *     liveness signal, not a release blocker. We exit 0 unconditionally
 *     and rely on the workflow's `continue-on-error: true` for the
 *     run step plus per-recipe `::warning::` annotations for the
 *     audit trail.
 *
 *   - **Per-page timeout**: each recipe fetch is capped at 90 s
 *     (signal-aborted) so a hung upstream cannot stall the whole job.
 *
 *   - **One retry**: a quick second attempt after a 5 s backoff covers
 *     transient network blips without papering over real breakage.
 *
 *   - **Imports compiled `dist/`**: the workflow runs `pnpm run build`
 *     first, then this script. We deliberately do not import directly
 *     from `src/` so the same code path users hit at install time is
 *     what the smoke job validates.
 */

import { getFeedAdapter } from "../dist/core/feeds/index.js";
import { listRecipes, mergeRecipeWithOverrides } from "../dist/core/recipes.js";
import { SourceSchema } from "../dist/schemas/source.js";

const PAGE_TIMEOUT_MS = 90_000;
const RETRY_DELAY_MS = 5_000;

/**
 * Wrap `fetch` with an `AbortSignal.timeout()` so a single recipe cannot
 * stall the whole job. We forward all other options unchanged so headers
 * / method / body interpolation behave identically to the production
 * adapter path.
 */
function makeTimeoutFetch(timeoutMs) {
  return (url, init = {}) =>
    fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe one recipe by issuing a single page-0 fetch (dryRun keeps the
 * adapter from walking pagination) and confirming at least one item
 * round-trips through the normalizer.
 */
async function probeRecipe(entry) {
  const name = entry.name;
  if (!entry.recipe) {
    return { name, ok: false, reason: `recipe failed to load: ${entry.error}` };
  }

  // Merge with a deterministic placeholder id and hand it to SourceSchema —
  // mirroring exactly what the CLI does at `radar source add --recipe`
  // time, so the smoke test exercises the same boundary.
  const candidate = mergeRecipeWithOverrides(entry.recipe, {
    id: `smoke-${name}`,
  });
  const validated = SourceSchema.safeParse(candidate);
  if (!validated.success) {
    return {
      name,
      ok: false,
      reason: `SourceSchema rejected merged recipe: ${validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }

  const adapter = getFeedAdapter(validated.data.kind);
  const fetchImpl = makeTimeoutFetch(PAGE_TIMEOUT_MS);

  // One retry on the first failure. We do NOT re-validate the recipe on
  // retry — that would be a code bug, not a transient network issue.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await adapter.fetch(validated.data, {
        fetch: fetchImpl,
        // `dryRun: true` caps the adapter at page 0, matching `source test`
        // semantics. State / items are not mutated; this is purely a
        // liveness check.
        dryRun: true,
      });
      // dev.to-style recipes hit page 0 once and stop; AWS What's New
      // returns one page with ~100 items. Either way we need at least one
      // item to call the recipe healthy.
      const itemCount = result.items?.length ?? 0;
      if (itemCount === 0) {
        return {
          name,
          ok: false,
          reason: "page-0 fetch returned 0 items (selector drift or empty upstream?)",
        };
      }
      return { name, ok: true, items: itemCount };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt === 1) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return { name, ok: false, reason: `fetch failed after retry: ${lastErr}` };
}

async function main() {
  const entries = await listRecipes();
  if (entries.length === 0) {
    console.log("::notice::recipes-smoke: no bundled recipes to probe");
    return;
  }
  console.log(`recipes-smoke: probing ${entries.length} recipe(s)`);

  let warningCount = 0;
  for (const entry of entries) {
    const start = Date.now();
    const probe = await probeRecipe(entry);
    const elapsed = Date.now() - start;
    if (probe.ok) {
      console.log(`  [ok]   ${probe.name} (${probe.items} items, ${elapsed} ms)`);
    } else {
      // GitHub Actions annotation format. `::warning::` lets the run
      // stay green at the workflow level while still surfacing the
      // breakage in the run summary and the Files Changed tab.
      console.log(`  [warn] ${probe.name}: ${probe.reason} (${elapsed} ms)`);
      console.log(`::warning title=recipes-smoke (${probe.name})::${probe.reason}`);
      warningCount++;
    }
  }
  if (warningCount > 0) {
    console.log(`recipes-smoke: ${warningCount} recipe(s) failed (treated as warnings)`);
  } else {
    console.log("recipes-smoke: all recipes passed");
  }
}

main().catch((err) => {
  // We catch unexpected crashes (not per-recipe failures) and surface
  // them as a single workflow-level warning. Exiting 0 matches the
  // "smoke job never blocks release" contract from ADR-0012 §D3.
  console.error("recipes-smoke: harness crashed:", err);
  console.log(`::warning title=recipes-smoke::harness crashed: ${err?.message ?? err}`);
});
