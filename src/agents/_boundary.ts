import type { Item } from "../schemas/index.js";

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
