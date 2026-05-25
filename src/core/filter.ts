import type { Item, MatchField, MatchMode, Source, SourceFilters } from "../schemas/index.js";

/**
 * Evaluate a single keyword against a haystack per the configured match mode.
 *
 * - `word`: whole-word match anchored on regex `\b` boundaries (keyword auto-escaped).
 * - `substring`: plain `indexOf`-style match.
 * - `regex`: treat the keyword as a JavaScript regular expression source. The
 *   `i` flag is added when `caseInsensitive` is true so character classes such
 *   as `\d` / `\W` retain their meaning (lowercasing the pattern source would
 *   silently corrupt them).
 *
 * For `word` and `substring` modes the caller is expected to have lowercased
 * both haystack and keyword when matching is case-insensitive.
 */
function matchKeyword(
  haystack: string,
  keyword: string,
  mode: MatchMode,
  caseInsensitive: boolean,
): boolean {
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
  // Use the `i` flag for case-insensitive runs rather than lowercasing the
  // pattern source — `\d` / `\D` / `\w` / `\W` flip meaning when lowercased,
  // which would silently break user patterns.
  const re = new RegExp(keyword, caseInsensitive ? "i" : "");
  return re.test(haystack);
}

/**
 * Resolve the text an item provides for a single `matchField`, or `null` when
 * the field is unavailable for this item / adapter kind.
 *
 * Fields the item does not provide (`body` / `tags` for RSS, an absent
 * `summary`, etc.) return `null` and are silently skipped by callers, per
 * ADR-0002's "adapters skip unavailable fields" rule. Splitting this out of
 * the old `buildHaystack` lets the evaluator score each field independently so
 * it can record *which* matchField produced a hit (#332 / `matchedFields`),
 * while still matching per field — `\b` word boundaries never merge tokens
 * across fields (e.g. title ending in "Claude" + summary starting with "Code"
 * cannot match `\bClaude Code\b`).
 */
function fieldText(item: Item, field: MatchField): string | null {
  if (field === "title") return item.title;
  if (field === "summary") return item.summary ?? null;
  // RSS adapter does not surface body / tags structurally; the schema does not
  // model them either. Silently skip rather than throw so a single filter
  // config can be reused across adapter kinds (ADR-0006).
  return null;
}

/**
 * Apply ADR-0006 filter semantics to a single item.
 *
 * Evaluation order (#332 changed step 1 from a single concatenated haystack to
 * per-field evaluation so the matched matchField is recorded; the accept /
 * reject outcome is unchanged for filters without `requireFields`):
 *   1. Build a per-field haystack for each available `matchField` (fields the
 *      adapter does not supply are skipped).
 *   2. If `caseSensitive` is false, lowercase each haystack and the keywords
 *      (word / substring modes). For regex mode, the `i` flag is used instead
 *      of lowercasing the pattern source.
 *   3. If any `excludeKeywords` hits in any field → reject (exclude wins).
 *   4. Collect include-keyword hits across all fields. Accept when at least one
 *      hit exists, recording every matched keyword in `matchedKeywords` and
 *      every field that produced a hit in `matchedFields`.
 *   5. If `requireFields` is non-empty, accept only when at least one hit
 *      landed in one of those fields; otherwise reject (#332 precision guard).
 *   6. Otherwise → reject.
 *
 * Returns the (possibly mutated) item annotated with `matchedKeywords` /
 * `matchedFields` when accepted, or null when filtered out.
 */
export function evaluateFilter(item: Item, filters: SourceFilters): Item | null {
  const isRegex = filters.matchMode === "regex";
  const caseInsensitive = !filters.caseSensitive;
  const normalizeKeyword = (s: string) => (caseInsensitive && !isRegex ? s.toLowerCase() : s);

  // Build one normalized haystack per available matchField (declaration order
  // preserved so matchedFields tracks the configured order). Fields the adapter
  // does not supply (null) are dropped here.
  const fieldHaystacks: Array<{ field: MatchField; haystack: string }> = [];
  for (const field of filters.matchFields) {
    const raw = fieldText(item, field);
    if (raw === null) continue;
    // For regex mode the haystack is not lowercased — we rely on the `i` flag
    // applied to the compiled pattern (see matchKeyword). For word / substring
    // modes we lowercase both haystack and keywords up front.
    const haystack = caseInsensitive && !isRegex ? raw.toLowerCase() : raw;
    fieldHaystacks.push({ field, haystack });
  }

  // Exclude has priority over include (ADR-0006 §評価順序 step 3). A hit in any
  // field rejects the item.
  for (const kw of filters.excludeKeywords) {
    const needle = normalizeKeyword(kw);
    for (const { haystack } of fieldHaystacks) {
      if (matchKeyword(haystack, needle, filters.matchMode, caseInsensitive)) {
        return null;
      }
    }
  }

  // Empty include list means "match nothing" — sources with no keywords cannot
  // emit items. This matches the ADR's worked example and avoids accidental
  // firehose ingestion when a user forgets to configure keywords.
  if (filters.keywords.length === 0) {
    return null;
  }

  // Collect include hits per field. `matchedKeywords` records every keyword
  // that hit (declaration order); `matchedFields` records every field that
  // produced at least one hit (matchFields order). The `Set` is reused for the
  // requireFields check below.
  const hits: string[] = [];
  const matchedFields: MatchField[] = [];
  const matchedFieldSet = new Set<MatchField>();
  for (const kw of filters.keywords) {
    const needle = normalizeKeyword(kw);
    let keywordHit = false;
    for (const { field, haystack } of fieldHaystacks) {
      if (matchKeyword(haystack, needle, filters.matchMode, caseInsensitive)) {
        keywordHit = true;
        if (!matchedFieldSet.has(field)) {
          matchedFieldSet.add(field);
          matchedFields.push(field);
        }
      }
    }
    if (keywordHit) hits.push(kw);
  }
  if (hits.length === 0) return null;

  // requireFields precision guard (#332): when set, at least one hit must have
  // landed in one of the required fields. This suppresses the summary-only
  // false-positive while still recording the matched summary context above.
  if (
    filters.requireFields.length > 0 &&
    !filters.requireFields.some((f) => matchedFieldSet.has(f))
  ) {
    return null;
  }

  return { ...item, matchedKeywords: hits, matchedFields };
}

/**
 * Apply a source's filter to a batch of items, returning only those that pass.
 *
 * Each returned item carries `matchedKeywords` (the include hits) and
 * `matchedFields` (which matchFields produced those hits, #332), so downstream
 * `items` writers can persist the evidence for later inspection.
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
