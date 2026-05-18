import type { Item, TrustLevel } from "../schemas/index.js";

/**
 * Trust-boundary marker helper for adapter prompt builders.
 *
 * Wraps externally-sourced content (feed item title / summary / raw body,
 * predecessor research body) with a `<untrusted_item>...</untrusted_item>`
 * tag pair so the LLM can distinguish trusted prompt instructions from
 * potentially adversarial upstream content.
 *
 * Background: ADR-0009 (M1c "Adopt") and the layer-1 defense described in
 * `knowledge/ai/practice/prompt-injection.md` § レイヤー 1. This is the
 * cheapest, highest-leverage prompt-injection mitigation we apply at the
 * adapter boundary; it works in pair with the SKILL-side guidance (M2a /
 * M2b) that tells agents not to follow instructions found inside the tag.
 *
 * Contract:
 * - The opening / closing tags are on their own lines so the wrapped content
 *   is visually and textually offset from the surrounding prompt.
 * - The helper does **not** sanitize, truncate, or HTML-escape the input.
 *   The threat model accepted in ADR-0009 is "untrusted but readable"; the
 *   tag is the boundary, not a filter.
 * - The helper is intentionally side-effect-free and returns a string so it
 *   can be composed inside `Array.prototype.join("\n")` prompt builders
 *   without changing their structure.
 */
export function wrapUntrusted(content: string): string {
  return `<untrusted_item>\n${content}\n</untrusted_item>`;
}

/**
 * Render a feed `Item` as the human-readable block that the adapter embeds in
 * the LLM prompt (research / update). The block lists the item's stable
 * identifier (`id` / `sourceId` / `url` — trusted metadata produced by the
 * detection layer) outside the boundary, and the agent-facing untrusted
 * payload (`title`, `summary`, `raw`) inside a single `<untrusted_item>` tag.
 *
 * Splitting trusted vs untrusted halves matters: the agent must be able to
 * follow `id` / `url` as routing hints, so those stay outside the marker. The
 * `title` / `summary` / `raw` fields originate from the upstream feed and
 * therefore go inside the boundary. See ADR-0009 § M1c for the rationale.
 *
 * `raw` is `z.unknown()` in the Item schema, so we JSON-stringify it for a
 * deterministic textual representation. Missing optional fields are omitted
 * from the block rather than rendered as `(none)` to keep the prompt compact.
 */
export function renderItemForPrompt(item: Item): string {
  const untrustedLines: string[] = [`title: ${item.title}`];
  if (item.summary !== undefined) {
    untrustedLines.push(`summary: ${item.summary}`);
  }
  if (item.raw !== undefined) {
    untrustedLines.push(`raw: ${JSON.stringify(item.raw)}`);
  }
  return [
    `- id: ${item.id}`,
    `  sourceId: ${item.sourceId}`,
    `  url: ${item.url}`,
    wrapUntrusted(untrustedLines.join("\n")),
  ].join("\n");
}

/**
 * Render a list of `Item`s as the human-readable block that the adapter embeds
 * in the LLM prompt for digest (multi-item) research.
 *
 * Contract (ADR-0011 §1, ADR-0009 M1c):
 *
 * - **Single-item case (N === 1)**: emits the exact same shape as
 *   `renderItemForPrompt(items[0])` — no section header is added so existing
 *   single-item prompts remain byte-equivalent (regression guard for issue
 *   #140's acceptance criteria).
 * - **Multi-item case (N > 1)**: each item is prefixed with an
 *   `### Item k of N` Markdown section header and rendered via
 *   `renderItemForPrompt`. Each item's untrusted halves stay in their own
 *   `<untrusted_item>...</untrusted_item>` boundary so a prompt-injection
 *   payload in one item cannot escape into the section between items.
 *
 * The header uses a `###` heading rather than a bare label so it survives
 * round-tripping through agents that render the prompt as Markdown (Claude
 * Code's transcript viewer, Codex's `<stdin>` echo, etc.). The blank line
 * between sections matters for the same reason: most Markdown parsers fold
 * adjacent blocks otherwise.
 */
export function renderItemsForPrompt(items: Item[]): string {
  if (items.length === 1) {
    // Preserve the byte-for-byte single-item layout from before #140 so
    // existing tests, snapshot fixtures, and single-item callers keep
    // working without churn.
    return renderItemForPrompt(items[0]);
  }
  const total = items.length;
  return items
    .map((item, idx) => `### Item ${idx + 1} of ${total}\n${renderItemForPrompt(item)}`)
    .join("\n\n");
}

/**
 * Resolve the effective trust level of a digest's combined prompt by taking
 * the most-restrictive level across its constituent items (ADR-0011 §7).
 *
 * Rule: `untrusted` > `trusted`. If **any** item is `untrusted`, the digest
 * as a whole is `untrusted` — the defense-in-depth "weakest link decides"
 * principle. This mirrors the ADR's safety justification: bundling one
 * untrusted item with N trusted ones still puts an injection payload inside
 * the same prompt context, so the whole prompt must be treated at the
 * untrusted ceiling.
 *
 * Edge case: an empty input array resolves to `untrusted` because the only
 * way to reach this helper with no items is a programming bug, and
 * defaulting to the safer side keeps the downstream boundary marker active.
 * Production callers (the CLI in #141) always pass at least one item, so
 * this branch is defensive-only.
 *
 * This helper deliberately lives in `_boundary.ts` (the prompt-builder side)
 * rather than `core/` because it is part of the M1c (boundary marker) layer
 * decision — it tells the prompt builder which marker policy to apply for
 * the bundle. Callers that already have per-item `Source` objects can map
 * them to `source.trustLevel` and pass the array in directly.
 */
export function resolveTrustLevel(levels: TrustLevel[]): TrustLevel {
  // Empty input is treated as `untrusted` per the JSDoc contract above — the
  // only way to reach this branch is a programming bug, so erring on the
  // safer side keeps the downstream boundary marker active.
  if (levels.length === 0) return "untrusted";
  return levels.some((level) => level === "untrusted") ? "untrusted" : "trusted";
}
