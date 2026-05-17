import { describe, expect, it } from "vitest";
import { ItemSchema, ItemStatusSchema } from "../../src/schemas/item.js";

/**
 * Item is the on-disk payload for items/<sourceId>/<itemId>.yaml. The
 * file format is part of the user-visible contract: a breaking change to
 * defaults / required fields silently corrupts every existing workspace,
 * so we pin the shape here.
 */

const MIN_VALID = {
  id: "anthropic-news-2026-05-10-claude-code-update",
  sourceId: "anthropic-news",
  title: "Claude Code update",
  url: "https://example.com/post",
  fetchedAt: "2026-05-10T00:00:00.000Z",
};

describe("schemas/item", () => {
  it("parses a minimal item and applies expected defaults", () => {
    const result = ItemSchema.parse(MIN_VALID);
    // Defaults are part of the contract: changing these silently
    // re-classifies every existing item on disk.
    expect(result.matchedKeywords).toEqual([]);
    expect(result.status).toBe("detected");
    expect(result.injectionFlags).toEqual([]);
  });

  it("accepts the full set of optional fields", () => {
    const result = ItemSchema.parse({
      ...MIN_VALID,
      publishedAt: "2026-05-09T12:00:00.000Z",
      summary: "ヘッドライン要約",
      raw: { rss: "<entry>...</entry>" },
      matchedKeywords: ["claude", "code"],
      status: "researched",
      injectionFlags: ["ignore_previous"],
    });
    expect(result.publishedAt).toBe("2026-05-09T12:00:00.000Z");
    expect(result.summary).toBe("ヘッドライン要約");
    expect(result.matchedKeywords).toEqual(["claude", "code"]);
    expect(result.status).toBe("researched");
    expect(result.injectionFlags).toEqual(["ignore_previous"]);
  });

  it("rejects empty id / sourceId (load would create unaddressable file)", () => {
    expect(ItemSchema.safeParse({ ...MIN_VALID, id: "" }).success).toBe(false);
    expect(ItemSchema.safeParse({ ...MIN_VALID, sourceId: "" }).success).toBe(false);
  });

  it("rejects a non-URL `url` (downstream commands open it in a browser)", () => {
    const result = ItemSchema.safeParse({ ...MIN_VALID, url: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO 8601 fetchedAt (state machine compares timestamps lexicographically)", () => {
    const result = ItemSchema.safeParse({ ...MIN_VALID, fetchedAt: "2026-05-10" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status value", () => {
    // ADR-0008 pins the state machine to detected | dismissed | researched | reviewed.
    // Adding a new state requires a deliberate schema + ADR update.
    const result = ItemSchema.safeParse({ ...MIN_VALID, status: "in_progress" });
    expect(result.success).toBe(false);
  });
});

describe("schemas/item — ItemStatusSchema (ADR-0008 state machine)", () => {
  it("accepts the 4 canonical states", () => {
    for (const status of ["detected", "dismissed", "researched", "reviewed"] as const) {
      expect(ItemStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects values outside the canonical set", () => {
    expect(ItemStatusSchema.safeParse("pending").success).toBe(false);
    expect(ItemStatusSchema.safeParse("").success).toBe(false);
    expect(ItemStatusSchema.safeParse(null).success).toBe(false);
  });
});
