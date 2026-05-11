import type { Item, MatchField, MatchMode, Source, SourceFilters } from "../schemas/index.js";

/**
 * Evaluate a single keyword against a haystack per the configured match mode.
 *
 * - `word`: whole-word match anchored on regex `\b` boundaries.
 * - `substring`: plain `indexOf`-style match.
 * - `regex`: treat the keyword as a JavaScript regular expression source.
 *
 * Callers are expected to lowercase both arguments beforehand when
 * `caseSensitive` is false. `caseSensitive` is honored at the call site to
 * avoid recompiling regexes for every item.
 */
function matchKeyword(haystack: string, keyword: string, mode: MatchMode): boolean {
  if (keyword.length === 0) return false;
  if (mode === "substring") {
    return haystack.includes(keyword);
  }
  if (mode === "word") {
    // Escape regex metachars in the user-supplied keyword so `word` mode is
    // never interpreted as a pattern (ADR-0006: word mode is literal).
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    return re.test(haystack);
  }
  // regex mode: compile the keyword as-is. Invalid regexes throw RegExp errors,
  // which we let propagate so the caller surfaces a clear validation failure.
  const re = new RegExp(keyword);
  return re.test(haystack);
}

/**
 * Concatenate the configured `matchFields` of an item into a single search
 * haystack. Fields that the item does not provide (`body` / `tags` for RSS,
 * etc.) are silently skipped, per ADR-0002's "adapters skip unavailable fields"
 * rule. Joining with newline keeps `\b` word boundaries from accidentally
 * merging tokens across fields (e.g. title ending in "Claude" + summary
 * starting with "Code" should not match `\bClaude Code\b`).
 */
function buildHaystack(item: Item, fields: MatchField[]): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (field === "title") {
      parts.push(item.title);
    } else if (field === "summary") {
      if (item.summary) parts.push(item.summary);
    } else if (field === "body" || field === "tags") {
      // RSS adapter does not surface body / tags structurally; the schema does
      // not model them either. Silently skip rather than throw so a single
      // filter config can be reused across adapter kinds (ADR-0006).
    }
  }
  return parts.join("\n");
}

/**
 * Apply ADR-0006 filter semantics to a single item.
 *
 * Evaluation order:
 *   1. Concatenate matchFields into a haystack.
 *   2. If `caseSensitive` is false, lowercase haystack and keywords.
 *   3. If any `excludeKeywords` hits → reject (exclude wins over include).
 *   4. If any `keywords` hits → accept, recording the hits in `matchedKeywords`.
 *   5. Otherwise → reject.
 *
 * Returns the (possibly mutated) item annotated with `matchedKeywords` when
 * accepted, or null when filtered out.
 */
export function evaluateFilter(item: Item, filters: SourceFilters): Item | null {
  const haystackRaw = buildHaystack(item, filters.matchFields);
  const haystack = filters.caseSensitive ? haystackRaw : haystackRaw.toLowerCase();

  const normalize = (s: string) => (filters.caseSensitive ? s : s.toLowerCase());

  // Exclude has priority over include (ADR-0006 §評価順序 step 3).
  for (const kw of filters.excludeKeywords) {
    if (matchKeyword(haystack, normalize(kw), filters.matchMode)) {
      return null;
    }
  }

  // Empty include list means "match nothing" — sources with no keywords cannot
  // emit items. This matches the ADR's worked example and avoids accidental
  // firehose ingestion when a user forgets to configure keywords.
  if (filters.keywords.length === 0) {
    return null;
  }

  const hits: string[] = [];
  for (const kw of filters.keywords) {
    if (matchKeyword(haystack, normalize(kw), filters.matchMode)) {
      hits.push(kw);
    }
  }
  if (hits.length === 0) return null;

  return { ...item, matchedKeywords: hits };
}

/**
 * Apply a source's filter to a batch of items, returning only those that pass.
 *
 * Each returned item carries `matchedKeywords` populated from the include hits,
 * so downstream `items` writers can persist the evidence for later inspection.
 */
export function filterItems(items: Item[], source: Source): Item[] {
  const filters = source.filters;
  const out: Item[] = [];
  for (const item of items) {
    const accepted = evaluateFilter(item, filters);
    if (accepted) out.push(accepted);
  }
  return out;
}
