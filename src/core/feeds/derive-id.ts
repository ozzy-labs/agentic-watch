import { createHash } from "node:crypto";

/**
 * Maximum number of characters kept from the title slug before the hash
 * suffix. 40 keeps `Item.id` short enough for shell args and file names while
 * still leaving room for human-readable context.
 */
const SLUG_MAX_LENGTH = 40;

/**
 * Length of the hash suffix appended to the slug. 8 hex chars (32 bits) is
 * enough to disambiguate same-title entries within a single source without
 * bloating ids — feeds have at most a few thousand active items, far below
 * the birthday-collision threshold.
 */
const HASH_SUFFIX_LENGTH = 8;

/**
 * Candidate inputs an adapter passes to `deriveStableKey()`. The adapter
 * ranks its candidates in preferred order (most-stable first); the helper
 * returns the first non-empty value, falling back to a `sha1:`-prefixed
 * content hash so the result is **always** defined.
 *
 * - `publisherId`: a stable id the publisher itself declares (RSS `guid`,
 *   GitHub release id, npm `<pkg>@<version>`, …). Preferred when present.
 * - `url`: the canonical URL of the entity. Preferred fallback because URLs
 *   are usually stable across re-fetches even when no explicit id is given.
 * - `fallbackHashInputs`: free-form strings (title, pubDate, …) hashed only
 *   when neither `publisherId` nor `url` exists. The `sha1:` prefix is
 *   retained from the legacy implementation so existing ids stay byte-stable
 *   across the refactor.
 */
export interface StableKeyCandidates {
  publisherId?: string;
  url?: string;
  fallbackHashInputs?: Array<string | undefined>;
}

/**
 * Pick the most stable identifier available for an entity from a
 * publisher-id-first fallback ladder. See ADR-0002 "Item ID 派生のコントラクト"
 * for the contract this helper enforces.
 *
 * The return value is opaque — callers pass it directly to `deriveItemId()`
 * (or hash it themselves) without inspecting the contents.
 */
export function deriveStableKey(candidates: StableKeyCandidates): string {
  const publisherId = trimToValue(candidates.publisherId);
  if (publisherId) return publisherId;
  const url = trimToValue(candidates.url);
  if (url) return url;
  const joined = (candidates.fallbackHashInputs ?? []).map((v) => v ?? "").join("|");
  return `sha1:${createHash("sha1").update(joined).digest("hex")}`;
}

/**
 * Build the canonical `Item.id` for a feed entry.
 *
 * Shape: `<title-slug>-<8 hex of sha256(stableKey)>` (or just the hash when
 * the title contains no slug-friendly characters).
 *
 * The title slug keeps ids human-readable in shell args and log lines; the
 * hash suffix makes the id stable across re-fetches and avoids collisions
 * between entries with identical titles within the same source. We hash the
 * adapter-selected `stableKey`, not the raw title, so two posts with the
 * same title still get distinct ids when their publisher ids differ.
 */
export function deriveItemId(title: string | undefined, stableKey: string): string {
  const hash = createHash("sha256").update(stableKey).digest("hex").slice(0, HASH_SUFFIX_LENGTH);
  const slug = slugifyTitle(title);
  return slug ? `${slug}-${hash}` : hash;
}

/** Title → kebab-case, lowercase, ASCII-only, capped at SLUG_MAX_LENGTH. */
function slugifyTitle(title: string | undefined): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

/** Trim a candidate and return `undefined` for empty strings. */
function trimToValue(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
