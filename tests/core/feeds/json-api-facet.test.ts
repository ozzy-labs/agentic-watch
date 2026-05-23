import { describe, expect, it } from "vitest";
import { jsonApiAdapter } from "../../../src/core/feeds/json-api.js";
import type { FetchLike } from "../../../src/core/feeds/types.js";
import type { Source } from "../../../src/schemas/index.js";

/**
 * Facet sweep tests for `kind: json-api` (ADR-0017).
 *
 * The outer facet loop wraps the existing pagination loop, injects
 * `param=template.replace("{}", value)` into the URL per facet value, and
 * aggregates items + lastSeenIds globally. Conditional GET is disabled in
 * facet sweep mode (per-facet ETag tracking is future work).
 */

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "aws-whats-new",
    kind: "json-api",
    url: "https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new-v2&size=100",
    tags: [],
    filters: {
      keywords: [],
      excludeKeywords: [],
      matchMode: "word",
      matchFields: ["title", "summary"],
      caseSensitive: false,
    },
    trustLevel: "untrusted",
    pagination: {
      type: "page",
      param: "page",
      start: 0,
      pageSize: 100,
      pageSizeParam: "size",
      maxPages: 30,
    },
    jsonSelectors: {
      items: "$.items[*]",
      title: "$.title",
      link: "$.url",
      publisherId: "$.id",
    },
    ...overrides,
  };
}

function itemBody(idPrefix: string, count: number): string {
  return JSON.stringify({
    items: Array.from({ length: count }, (_, i) => ({
      id: `${idPrefix}-${i}`,
      title: `Item ${idPrefix} ${i}`,
      url: `https://aws.amazon.com/about-aws/whats-new/${idPrefix}/${i}/`,
    })),
  });
}

describe("core/feeds/json-api — facet sweep (ADR-0017)", () => {
  it("walks the full range and substitutes the facet value into the URL", async () => {
    // 3-year range with 1 item per year → 3 items total. The mock asserts
    // each year is fetched and that the `tags.id` query param carries the
    // year-templated string.
    const source = makeSource({
      facets: {
        year: {
          type: "range",
          range: [2024, 2026],
          step: 1,
          param: "tags.id",
          template: "whats-new-v2#year#{}",
        },
      },
    });
    const calls: Array<{ url: string }> = [];
    const fetchImpl: FetchLike = async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push({ url: urlStr });
      // Decide what body to return based on which year appears in the URL.
      let body: string;
      if (urlStr.includes("year%232024")) body = itemBody("y2024", 1);
      else if (urlStr.includes("year%232025")) body = itemBody("y2025", 1);
      else if (urlStr.includes("year%232026")) body = itemBody("y2026", 1);
      else throw new Error(`unexpected url: ${urlStr}`);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => body,
      };
    };

    const result = await jsonApiAdapter.fetch(source, { fetch: fetchImpl });

    // 3 facet values × 1 item per year = 3 items aggregated.
    expect(result.items).toHaveLength(3);
    // First call: year=2024 (range start), URL-encoded.
    expect(calls[0]?.url).toContain("tags.id=whats-new-v2%23year%232024");
    expect(calls[1]?.url).toContain("tags.id=whats-new-v2%23year%232025");
    expect(calls[2]?.url).toContain("tags.id=whats-new-v2%23year%232026");
    // ADR-0017 §State: ETag is not persisted in facet sweep mode.
    expect(result.state.lastEtag).toBeUndefined();
  });

  it("aggregates lastSeenIds across all facet values (global set)", async () => {
    // Verify the inner fetchSingle receives the running aggregated
    // lastSeenIds so early-stop dedupes against items already observed
    // in earlier facet values.
    const source = makeSource({
      facets: {
        year: {
          type: "range",
          range: [2025, 2026],
          step: 1,
          param: "tags.id",
          template: "y-{}",
        },
      },
    });
    const fetchImpl: FetchLike = async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const body = urlStr.includes("y-2025") ? itemBody("y2025", 2) : itemBody("y2026", 2);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => body,
      };
    };
    const result = await jsonApiAdapter.fetch(source, { fetch: fetchImpl });
    // 2 years × 2 items = 4 items, all unique → all 4 should be present.
    expect(result.items).toHaveLength(4);
  });

  it("does NOT send conditional GET headers in facet sweep mode", async () => {
    // ADR-0017 §State: per-facet ETag tracking is deferred. The outer
    // loop forces conditional GET off so a stale ETag from a previous run
    // does not 304-out an entire facet value.
    const source = makeSource({
      facets: {
        year: {
          type: "range",
          range: [2025, 2026],
          step: 1,
          param: "tags.id",
          template: "y-{}",
        },
      },
    });
    const headersSeen: Array<Record<string, string> | undefined> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      headersSeen.push(init?.headers as Record<string, string> | undefined);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => itemBody("any", 1),
      };
    };
    await jsonApiAdapter.fetch(source, {
      fetch: fetchImpl,
      state: { sourceId: source.id, lastEtag: '"prev"', lastSeenIds: [] },
    });
    // Every request should have NO `if-none-match` header.
    for (const headers of headersSeen) {
      expect(headers?.["if-none-match"]).toBeUndefined();
    }
  });

  it("throws when multiple facets are declared (Phase 1 limitation)", async () => {
    // ADR-0017 §Scope: multi-facet composition (year × category) is
    // future work. The schema accepts a record shape for forward-compat,
    // but the adapter throws at runtime so misuse is loud.
    const source = makeSource({
      facets: {
        year: {
          type: "range",
          range: [2024, 2026],
          step: 1,
          param: "tags.id",
          template: "year-{}",
        },
        category: {
          type: "enum",
          values: ["a", "b"],
          param: "category",
          template: "{}",
        },
      },
    });
    const fetchImpl: FetchLike = async () => {
      throw new Error("should not fetch");
    };
    await expect(jsonApiAdapter.fetch(source, { fetch: fetchImpl })).rejects.toThrow(/Phase 1/);
  });

  it("respects enum facet values", async () => {
    const source = makeSource({
      facets: {
        category: {
          type: "enum",
          values: ["compute", "storage"],
          param: "category",
          template: "{}",
        },
      },
    });
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push(urlStr);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => itemBody("any", 1),
      };
    };
    await jsonApiAdapter.fetch(source, { fetch: fetchImpl });
    expect(calls[0]).toContain("category=compute");
    expect(calls[1]).toContain("category=storage");
  });

  it("walks only the first facet value in dry-run mode", async () => {
    // `source test` is dry-run; the facet outer loop should short-circuit
    // after the first facet value so the preview stays cheap.
    const source = makeSource({
      facets: {
        year: {
          type: "range",
          range: [2024, 2026],
          step: 1,
          param: "tags.id",
          template: "y-{}",
        },
      },
    });
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push(urlStr);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => itemBody("y2024", 1),
      };
    };
    const result = await jsonApiAdapter.fetch(source, { fetch: fetchImpl, dryRun: true });
    // Only the first facet value (2024) should have been fetched, even
    // though the range covers 3 years.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("y-2024");
    expect(result.items).toHaveLength(1);
  });

  it("range with step > 1 skips intermediate values", async () => {
    const source = makeSource({
      facets: {
        year: {
          type: "range",
          range: [2020, 2026],
          step: 2,
          param: "tags.id",
          template: "y-{}",
        },
      },
    });
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push(urlStr);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => itemBody("any", 1),
      };
    };
    await jsonApiAdapter.fetch(source, { fetch: fetchImpl });
    // 2020, 2022, 2024, 2026 → 4 calls.
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain("y-2020");
    expect(calls[1]).toContain("y-2022");
    expect(calls[2]).toContain("y-2024");
    expect(calls[3]).toContain("y-2026");
  });

  it("falls through to the non-facet code path when facets is omitted", async () => {
    // Backward compat: existing recipes without `facets:` should behave
    // identically to pre-ADR-0017 (single-axis pagination only).
    const source = makeSource(); // no facets
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "etag" ? '"v1"' : null),
      },
      text: async () => itemBody("flat", 1),
    });
    const result = await jsonApiAdapter.fetch(source, { fetch: fetchImpl });
    expect(result.items).toHaveLength(1);
    // ETag is preserved on the non-facet path.
    expect(result.state.lastEtag).toBe('"v1"');
  });
});
