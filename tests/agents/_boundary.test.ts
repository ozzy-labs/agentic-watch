import { describe, expect, it } from "vitest";
import {
  renderItemForPrompt,
  renderItemsForPrompt,
  resolveTrustLevel,
  wrapUntrusted,
} from "../../src/agents/_boundary.js";
import type { Item, TrustLevel } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Direct coverage for the helpers in `src/agents/_boundary.ts`.
 *
 * The adapter tests (claude-code / codex-cli / gemini-cli / copilot) already
 * exercise these helpers transitively, but a dedicated suite pins the
 * contracts so future adapter / SKILL changes can rely on byte-stable
 * behaviour:
 *
 * - `renderItemsForPrompt(items)` returns byte-identical output to
 *   `renderItemForPrompt(items[0])` for a 1-element array (regression guard
 *   for issue #140 "single-item prompt unchanged" acceptance criterion).
 * - Multi-item arrays emit `### Item k of N` headings and one
 *   `<untrusted_item>` boundary marker per item.
 * - `resolveTrustLevel(levels)` follows ADR-0011 §7: any `untrusted` input
 *   resolves to `untrusted`, otherwise `trusted`.
 */

const ITEM_A: Item = ItemSchema.parse({
  id: "anthropic-news-2026-05-10-claude-code",
  sourceId: "anthropic-news",
  title: "Claude Code: shiny new feature",
  url: "https://anthropic.com/news/claude-code-shiny",
  publishedAt: "2026-05-10T00:00:00.000Z",
  fetchedAt: "2026-05-10T01:00:00.000Z",
  summary: "New feature in Claude Code.",
  matchedKeywords: ["Claude Code"],
  status: "detected",
});

const ITEM_B: Item = ItemSchema.parse({
  id: "hacker-news-39876543-claude-code",
  sourceId: "hacker-news",
  title: "Show HN: claude-code in production",
  url: "https://news.ycombinator.com/item?id=39876543",
  publishedAt: "2026-05-11T12:00:00.000Z",
  fetchedAt: "2026-05-11T12:30:00.000Z",
  summary: "We migrated our research pipeline to claude-code.",
  matchedKeywords: ["Claude Code"],
  status: "detected",
});

describe("agents/_boundary.wrapUntrusted", () => {
  it("wraps content in the M1c boundary marker pair on their own lines", () => {
    expect(wrapUntrusted("hello\nworld")).toBe("<untrusted_item>\nhello\nworld\n</untrusted_item>");
  });
});

describe("agents/_boundary.renderItemForPrompt", () => {
  it("emits trusted id / sourceId / url outside the boundary and untrusted fields inside", () => {
    const rendered = renderItemForPrompt(ITEM_A);
    expect(rendered).toContain(`- id: ${ITEM_A.id}`);
    expect(rendered).toContain(`  sourceId: ${ITEM_A.sourceId}`);
    expect(rendered).toContain(`  url: ${ITEM_A.url}`);
    expect(rendered).toMatch(/<untrusted_item>\ntitle: .*\nsummary: .*\n<\/untrusted_item>/);
  });

  it("omits optional summary / raw lines when the source feed did not supply them", () => {
    const bareItem = ItemSchema.parse({
      id: ITEM_A.id,
      sourceId: ITEM_A.sourceId,
      title: ITEM_A.title,
      url: ITEM_A.url,
      fetchedAt: ITEM_A.fetchedAt,
    });
    const rendered = renderItemForPrompt(bareItem);
    expect(rendered).not.toContain("summary:");
    expect(rendered).not.toContain("raw:");
  });
});

describe("agents/_boundary.renderItemsForPrompt", () => {
  it("returns byte-identical output to renderItemForPrompt for a 1-element array (regression guard)", () => {
    expect(renderItemsForPrompt([ITEM_A])).toBe(renderItemForPrompt(ITEM_A));
  });

  it("adds `### Item k of N` headers and per-item boundary markers when N > 1", () => {
    const rendered = renderItemsForPrompt([ITEM_A, ITEM_B]);
    expect(rendered).toContain("### Item 1 of 2");
    expect(rendered).toContain("### Item 2 of 2");
    expect(rendered).toContain(ITEM_A.id);
    expect(rendered).toContain(ITEM_B.id);
    const openCount = (rendered.match(/<untrusted_item>/g) ?? []).length;
    const closeCount = (rendered.match(/<\/untrusted_item>/g) ?? []).length;
    expect(openCount).toBe(2);
    expect(closeCount).toBe(2);
  });

  it("places the heading above each item's render and keeps items separated by a blank line", () => {
    const rendered = renderItemsForPrompt([ITEM_A, ITEM_B]);
    // Heading line precedes the trusted id line for each item.
    expect(rendered).toMatch(new RegExp(`### Item 1 of 2\\n- id: ${ITEM_A.id}`));
    expect(rendered).toMatch(new RegExp(`### Item 2 of 2\\n- id: ${ITEM_B.id}`));
    // Items are separated by a blank line so Markdown parsers do not collapse
    // the two `### …` sections into one block.
    expect(rendered).toContain("</untrusted_item>\n\n### Item 2 of 2");
  });
});

describe("agents/_boundary.resolveTrustLevel (ADR-0011 §7)", () => {
  it("returns 'trusted' when every input is 'trusted'", () => {
    const levels: TrustLevel[] = ["trusted", "trusted", "trusted"];
    expect(resolveTrustLevel(levels)).toBe("trusted");
  });

  it("returns 'untrusted' when every input is 'untrusted'", () => {
    const levels: TrustLevel[] = ["untrusted", "untrusted"];
    expect(resolveTrustLevel(levels)).toBe("untrusted");
  });

  it("returns 'untrusted' when the inputs mix trusted and untrusted (most-restrictive)", () => {
    const mixed1: TrustLevel[] = ["trusted", "untrusted"];
    const mixed2: TrustLevel[] = ["untrusted", "trusted"];
    const mixed3: TrustLevel[] = ["trusted", "trusted", "untrusted", "trusted"];
    expect(resolveTrustLevel(mixed1)).toBe("untrusted");
    expect(resolveTrustLevel(mixed2)).toBe("untrusted");
    expect(resolveTrustLevel(mixed3)).toBe("untrusted");
  });

  it("returns 'untrusted' for an empty input (defensive default)", () => {
    expect(resolveTrustLevel([])).toBe("untrusted");
  });
});
