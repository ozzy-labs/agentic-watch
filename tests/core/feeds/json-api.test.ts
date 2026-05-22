import { describe, expect, it } from "vitest";
import { jsonApiAdapter } from "../../../src/core/feeds/json-api.js";
import type { FetchLike } from "../../../src/core/feeds/types.js";
import type { Source } from "../../../src/schemas/index.js";

interface MockResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function mockFetch(responses: MockResponse[]): {
  fetch: FetchLike;
  calls: Array<{ url: string; headers?: Record<string, string> }>;
} {
  const queue = [...responses];
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), headers: init?.headers });
    const next = queue.shift();
    if (!next) throw new Error(`no more mock responses (queue exhausted at call #${calls.length})`);
    return {
      status: next.status,
      headers: {
        get(name: string): string | null {
          const lower = name.toLowerCase();
          for (const [k, v] of Object.entries(next.headers ?? {})) {
            if (k.toLowerCase() === lower) return v;
          }
          return null;
        },
      },
      text: async () => next.body ?? "",
    };
  };
  return { fetch: fetchImpl, calls };
}

/**
 * Build a `Source` for `kind: json-api`. The schema's default for `tags` /
 * `filters` / `trustLevel` is applied here so each test has a fully-populated
 * shape (the adapter only consults a subset, but `Source` is used as the
 * function signature).
 */
function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "aws-whats-new",
    kind: "json-api",
    url: "https://aws.amazon.com/api/dirs/items/search",
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
      pageSize: 2,
      pageSizeParam: "size",
      maxPages: 20,
    },
    jsonSelectors: {
      items: "$.items[*]",
      title: "$.title",
      link: "$.url",
      publisherId: "$.id",
      publishedAt: "$.publishedAt",
    },
    ...overrides,
  };
}

function pageBody(idsStart: number, count: number, total = 100): string {
  return JSON.stringify({
    total,
    items: Array.from({ length: count }, (_, i) => ({
      id: `awn-${idsStart + i}`,
      title: `What's New ${idsStart + i}`,
      url: `https://aws.amazon.com/about-aws/whats-new/${idsStart + i}/`,
      publishedAt: "2026-05-12T09:00:00Z",
    })),
  });
}

describe("core/feeds/json-api — single fetch (kind: none)", () => {
  it("normalizes items and derives stable ids", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
    });
    const { fetch } = mockFetch([
      {
        status: 200,
        body: pageBody(1, 2),
        headers: { ETag: '"v1"' },
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.title).toBe("What's New 1");
    expect(result.items[0]?.url).toBe("https://aws.amazon.com/about-aws/whats-new/1/");
    expect(result.items[0]?.id).toMatch(/^what-s-new-1-[0-9a-f]{8}$/);
    expect(result.state.lastEtag).toBe('"v1"');
  });

  it("falls back to a content hash when the server omits ETag", async () => {
    const source = makeSource({ pagination: { type: "none", maxPages: 20 } });
    const { fetch } = mockFetch([{ status: 200, body: pageBody(1, 1) }]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.state.lastEtag).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("derives ids from url when publisherId is omitted", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      jsonSelectors: {
        items: "$.items[*]",
        title: "$.title",
        link: "$.url",
      },
    });
    const { fetch: fetchA } = mockFetch([{ status: 200, body: pageBody(1, 1) }]);
    const { fetch: fetchB } = mockFetch([{ status: 200, body: pageBody(1, 1) }]);
    const a = await jsonApiAdapter.fetch(source, { fetch: fetchA });
    const b = await jsonApiAdapter.fetch(source, { fetch: fetchB });
    expect(a.items[0]?.id).toBe(b.items[0]?.id);
  });

  it("returns 304 notModified when the server reports unchanged", async () => {
    const source = makeSource({ pagination: { type: "none", maxPages: 20 } });
    const { fetch, calls } = mockFetch([{ status: 304, headers: { ETag: '"keep"' } }]);
    const result = await jsonApiAdapter.fetch(source, {
      fetch,
      state: { sourceId: "x", lastEtag: '"keep"', lastSeenIds: [] },
    });
    expect(result.notModified).toBe(true);
    expect(result.items).toEqual([]);
    expect(calls[0]?.headers?.["if-none-match"]).toBe('"keep"');
  });

  it("skips conditional GET in backfill mode (no If-None-Match)", async () => {
    // Backfill should fetch full history even if the server would have
    // 304'd against the previous-run ETag — that ETag was captured from a
    // partial fetch and should not block a deliberate backfill.
    const source = makeSource({
      pagination: { type: "page", param: "page", start: 0, pageSize: 1, maxPages: 1 },
    });
    const { fetch, calls } = mockFetch([{ status: 200, body: pageBody(1, 1) }]);
    await jsonApiAdapter.fetch(source, {
      fetch,
      backfill: true,
      state: { sourceId: "x", lastEtag: '"stale"', lastSeenIds: [] },
    });
    expect(calls[0]?.headers?.["if-none-match"]).toBeUndefined();
  });
});

describe("core/feeds/json-api — pagination strategies", () => {
  it("walks pages with type: page (backfill)", async () => {
    const source = makeSource();
    const { fetch, calls } = mockFetch([
      { status: 200, body: pageBody(1, 2, 5) },
      { status: 200, body: pageBody(3, 2, 5) },
      { status: 200, body: pageBody(5, 1, 5) },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch, backfill: true });
    expect(result.items).toHaveLength(5);
    // The page query param is incremented across calls.
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toContain("page=1");
    expect(calls[2]?.url).toContain("page=2");
  });

  it("walks offset pagination (type: offset)", async () => {
    const source = makeSource({
      pagination: {
        type: "offset",
        param: "offset",
        start: 0,
        pageSize: 2,
        pageSizeParam: "limit",
        maxPages: 20,
      },
    });
    const { fetch, calls } = mockFetch([
      { status: 200, body: pageBody(1, 2) },
      { status: 200, body: pageBody(3, 2) },
      { status: 200, body: pageBody(5, 0) },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch, backfill: true });
    expect(result.items).toHaveLength(4);
    expect(calls[1]?.url).toContain("offset=2");
    expect(calls[2]?.url).toContain("offset=4");
  });

  it("walks cursor pagination using nextCursorPath", async () => {
    const source = makeSource({
      pagination: {
        type: "cursor",
        param: "after",
        nextCursorPath: "$.nextCursor",
        maxPages: 20,
      },
    });
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [{ id: "a", title: "A", url: "https://x.example/a" }],
          nextCursor: "cur1",
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          items: [{ id: "b", title: "B", url: "https://x.example/b" }],
          nextCursor: "cur2",
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          items: [{ id: "c", title: "C", url: "https://x.example/c" }],
          // No nextCursor → traversal stops.
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch, backfill: true });
    expect(result.items).toHaveLength(3);
    expect(calls[1]?.url).toContain("after=cur1");
    expect(calls[2]?.url).toContain("after=cur2");
  });

  it("walks token pagination (opaque continuation)", async () => {
    const source = makeSource({
      pagination: {
        type: "token",
        param: "pageToken",
        nextCursorPath: "$.nextPageToken",
        maxPages: 20,
      },
    });
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [{ id: "a", title: "A", url: "https://x.example/a" }],
          nextPageToken: "tok1",
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          items: [{ id: "b", title: "B", url: "https://x.example/b" }],
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch, backfill: true });
    expect(result.items).toHaveLength(2);
    expect(calls[1]?.url).toContain("pageToken=tok1");
  });

  it("walks link-header pagination", async () => {
    const source = makeSource({
      pagination: { type: "link-header", maxPages: 20 },
    });
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [{ id: "a", title: "A", url: "https://x.example/a" }],
        }),
        headers: { Link: '<https://x.example/api?page=2>; rel="next"' },
      },
      {
        status: 200,
        body: JSON.stringify({
          items: [{ id: "b", title: "B", url: "https://x.example/b" }],
        }),
        // No Link header on the last page → loop stops.
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch, backfill: true });
    expect(result.items).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://x.example/api?page=2");
  });

  it("stops at maxPages cap even when more pages would be available", async () => {
    const source = makeSource({
      pagination: {
        type: "page",
        param: "page",
        start: 0,
        pageSize: 1,
        pageSizeParam: "size",
        maxPages: 2,
      },
    });
    const { fetch, calls } = mockFetch([
      { status: 200, body: pageBody(1, 1, 100) },
      { status: 200, body: pageBody(2, 1, 100) },
      { status: 200, body: pageBody(3, 1, 100) },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch, backfill: true });
    // Cap is 2 → only the first 2 pages are fetched.
    expect(result.items).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("respects --max-pages override for backfill", async () => {
    const source = makeSource({
      pagination: {
        type: "page",
        param: "page",
        start: 0,
        pageSize: 1,
        pageSizeParam: "size",
        maxPages: 20, // recipe cap is high…
      },
    });
    const { fetch, calls } = mockFetch([
      { status: 200, body: pageBody(1, 1, 100) },
      { status: 200, body: pageBody(2, 1, 100) },
    ]);
    // …but the CLI override clamps to 1 page.
    const result = await jsonApiAdapter.fetch(source, {
      fetch,
      backfill: true,
      maxPagesOverride: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("uses totalPath in backfill to short-circuit traversal", async () => {
    const source = makeSource({
      pagination: {
        type: "page",
        param: "page",
        start: 0,
        pageSize: 2,
        pageSizeParam: "size",
        maxPages: 20,
        totalPath: "$.total",
      },
    });
    // 3 total items / 2 per page → 2 pages needed.
    const { fetch, calls } = mockFetch([
      { status: 200, body: pageBody(1, 2, 3) },
      { status: 200, body: pageBody(3, 1, 3) },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch, backfill: true });
    expect(result.items).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it("stops on empty page even when pagination would continue", async () => {
    const source = makeSource();
    const { fetch, calls } = mockFetch([
      { status: 200, body: pageBody(1, 2) },
      { status: 200, body: JSON.stringify({ items: [] }) },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch, backfill: true });
    expect(result.items).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});

describe("core/feeds/json-api — normal mode (no backfill)", () => {
  it("stops after one page when items.length < pageSize (end-of-pagination)", async () => {
    const source = makeSource();
    // pageBody count=1 < pageSize=2 → heuristic stops after page 0.
    const { fetch, calls } = mockFetch([{ status: 200, body: pageBody(1, 1) }]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("does early-stop when page 0 contains a previously-seen id", async () => {
    const source = makeSource();
    // Page 0 contains 2 items at pageSize=2; the size heuristic would normally
    // continue to page 1, but the seenId hit takes precedence and stops the
    // loop after page 0.
    const { fetch, calls } = mockFetch([{ status: 200, body: pageBody(1, 2) }]);
    // Compute the id of item 1 the same way the adapter will, by running
    // the adapter once with an empty state and reading back the first item id.
    const first = await jsonApiAdapter.fetch(makeSource(), {
      fetch: mockFetch([{ status: 200, body: pageBody(1, 1) }]).fetch,
    });
    const knownId = first.items[0]?.id;
    if (!knownId) throw new Error("expected first.items[0] to be defined");

    const result = await jsonApiAdapter.fetch(source, {
      fetch,
      state: { sourceId: "x", lastEtag: undefined, lastSeenIds: [knownId] },
    });
    expect(calls).toHaveLength(1);
    expect(result.items).toHaveLength(2);
  });

  it("walks pages in normal mode until items.length < pageSize", async () => {
    // No backfill, but page 0 fills + page 1 partial → stops after page 1.
    const source = makeSource();
    const { fetch, calls } = mockFetch([
      { status: 200, body: pageBody(1, 2) },
      { status: 200, body: pageBody(3, 1) }, // partial page → stop
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });
});

describe("core/feeds/json-api — selectors fallback chain", () => {
  it("uses the default selector chain when items is omitted", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      jsonSelectors: {
        // No `items` declared — fall back to `$.data[*]` after `$.items[*]` misses.
        title: "$.title",
        link: "$.url",
      },
    });
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: "x", title: "X", url: "https://x.example/x" },
            { id: "y", title: "Y", url: "https://x.example/y" },
          ],
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.title).toBe("X");
  });
});

describe("core/feeds/json-api — header interpolation", () => {
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: `${VAR}` is
  // an intentional literal placeholder per ADR-0012 §D5c — the adapter
  // interpolates these strings at runtime.
  it("interpolates ${VAR} env in headers when present", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      http: {
        method: "GET",
        headers: { Authorization: "Bearer ${TEST_TOKEN}" },
      },
    });
    const { fetch, calls } = mockFetch([{ status: 200, body: pageBody(1, 1) }]);
    await jsonApiAdapter.fetch(source, { fetch, env: { TEST_TOKEN: "secret-xyz" } });
    expect(calls[0]?.headers?.authorization).toBe("Bearer secret-xyz");
  });

  it("drops a header entirely when ${VAR} is unresolved (degraded fetch)", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      http: {
        method: "GET",
        headers: { Authorization: "Bearer ${MISSING}" },
      },
    });
    const { fetch, calls } = mockFetch([{ status: 200, body: pageBody(1, 1) }]);
    await jsonApiAdapter.fetch(source, { fetch, env: {} });
    expect(calls[0]?.headers?.authorization).toBeUndefined();
    // The default accept / user-agent are still present.
    expect(calls[0]?.headers?.accept).toContain("application/json");
    expect(calls[0]?.headers?.["user-agent"]).toContain("feedradar");
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: see preceding comment

  it("passes literal header values through unchanged", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      http: {
        method: "GET",
        headers: { "X-Client-Id": "feedradar-recipes" },
      },
    });
    const { fetch, calls } = mockFetch([{ status: 200, body: pageBody(1, 1) }]);
    await jsonApiAdapter.fetch(source, { fetch, env: {} });
    expect(calls[0]?.headers?.["x-client-id"]).toBe("feedradar-recipes");
  });
});

describe("core/feeds/json-api — normalization defenses", () => {
  it("drops items missing a url", async () => {
    const source = makeSource({ pagination: { type: "none", maxPages: 20 } });
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [
            { id: "ok", title: "Has url", url: "https://x.example/ok" },
            { id: "no-url", title: "Missing url" }, // dropped
            { id: "ok2", title: "Has url 2", url: "https://x.example/ok2" },
          ],
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.title)).toEqual(["Has url", "Has url 2"]);
  });

  it("coerces unix-style date strings into ISO 8601", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      jsonSelectors: {
        items: "$.items[*]",
        title: "$.title",
        link: "$.url",
        publishedAt: "$.created_at",
      },
    });
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              title: "Dated",
              url: "https://x.example/d",
              created_at: "2026-05-12T09:00:00Z",
            },
          ],
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items[0]?.publishedAt).toBe("2026-05-12T09:00:00.000Z");
  });

  it("falls back to body when the recipe only mapped a body selector", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      jsonSelectors: {
        items: "$.items[*]",
        title: "$.title",
        link: "$.url",
        body: "$.postBody",
      },
    });
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              title: "T",
              url: "https://x.example/t",
              postBody: "Long body content here",
            },
          ],
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items[0]?.summary).toBe("Long body content here");
  });
});

describe("core/feeds/json-api — tags coercion variants", () => {
  it("normalizes string-array tags", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      jsonSelectors: {
        items: "$.items[*]",
        title: "$.title",
        link: "$.url",
        tags: "$.tags",
      },
    });
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [{ title: "T", url: "https://x.example/t", tags: ["a", "b", "c"] }],
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items).toHaveLength(1);
    // Tags are stashed in raw; the schema doesn't put item-level tags
    // anywhere structured. Just verify the item parsed cleanly.
    expect(result.items[0]?.raw).toMatchObject({ tags: ["a", "b", "c"] });
  });

  it("normalizes a comma-separated string tags value", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      jsonSelectors: {
        items: "$.items[*]",
        title: "$.title",
        link: "$.url",
        tags: "$.tags",
      },
    });
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [{ title: "T", url: "https://x.example/t", tags: "release, beta" }],
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items).toHaveLength(1);
  });

  it("handles object-shaped tags safely (no crash)", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      jsonSelectors: {
        items: "$.items[*]",
        title: "$.title",
        link: "$.url",
        tags: "$.tags",
      },
    });
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [{ title: "T", url: "https://x.example/t", tags: { primary: "x" } }],
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch });
    expect(result.items).toHaveLength(1);
  });
});

describe("core/feeds/json-api — defensive header interpolation", () => {
  it("treats a missing close brace as a literal (no header drop)", async () => {
    const source = makeSource({
      pagination: { type: "none", maxPages: 20 },
      http: {
        method: "GET",
        // Malformed: missing `}` — should pass through as literal so we
        // don't accidentally drop the entire header.
        headers: { "X-Custom": "prefix-${UNTERMINATED" },
      },
    });
    const { fetch, calls } = mockFetch([{ status: 200, body: pageBody(1, 1) }]);
    await jsonApiAdapter.fetch(source, { fetch, env: {} });
    expect(calls[0]?.headers?.["x-custom"]).toBe("prefix-${UNTERMINATED");
  });
});

describe("core/feeds/json-api — link-header parser", () => {
  it("ignores rel=prev / rel=first when picking next", async () => {
    const source = makeSource({
      pagination: { type: "link-header", maxPages: 20 },
    });
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: JSON.stringify({
          items: [{ id: "a", title: "A", url: "https://x.example/a" }],
        }),
        headers: {
          Link: '<https://x.example/api?page=1>; rel="prev", <https://x.example/api?page=3>; rel="next", <https://x.example/api?page=1>; rel="first"',
        },
      },
      {
        status: 200,
        body: JSON.stringify({
          items: [{ id: "b", title: "B", url: "https://x.example/b" }],
        }),
      },
    ]);
    const result = await jsonApiAdapter.fetch(source, { fetch, backfill: true });
    expect(result.items).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://x.example/api?page=3");
  });
});

describe("core/feeds/json-api — error handling", () => {
  it("throws on 401", async () => {
    const source = makeSource({ pagination: { type: "none", maxPages: 20 } });
    const { fetch } = mockFetch([{ status: 401 }]);
    await expect(jsonApiAdapter.fetch(source, { fetch })).rejects.toThrow(/HTTP 401/);
  });

  it("throws on 404", async () => {
    const source = makeSource({ pagination: { type: "none", maxPages: 20 } });
    const { fetch } = mockFetch([{ status: 404 }]);
    await expect(jsonApiAdapter.fetch(source, { fetch })).rejects.toThrow(/HTTP 404/);
  });

  it("throws when body exceeds the 10 MB cap", async () => {
    const source = makeSource({ pagination: { type: "none", maxPages: 20 } });
    // Build a 10 MB + 1 byte payload that still parses as JSON.
    const big = "x".repeat(10 * 1024 * 1024);
    const body = JSON.stringify({ items: [{ title: big, url: "https://x.example/x" }] });
    const { fetch } = mockFetch([{ status: 200, body }]);
    await expect(jsonApiAdapter.fetch(source, { fetch })).rejects.toThrow(/response too large/);
  });

  it("throws on invalid JSON", async () => {
    const source = makeSource({ pagination: { type: "none", maxPages: 20 } });
    const { fetch } = mockFetch([{ status: 200, body: "not-json" }]);
    await expect(jsonApiAdapter.fetch(source, { fetch })).rejects.toThrow(/failed to parse JSON/);
  });

  it("rejects sources missing pagination", async () => {
    // Bypass the schema validation to exercise the adapter's own guard.
    const broken = makeSource();
    delete (broken as { pagination?: unknown }).pagination;
    const { fetch } = mockFetch([]);
    await expect(jsonApiAdapter.fetch(broken, { fetch })).rejects.toThrow(/no pagination/);
  });

  it("rejects sources missing jsonSelectors", async () => {
    const broken = makeSource();
    delete (broken as { jsonSelectors?: unknown }).jsonSelectors;
    const { fetch } = mockFetch([]);
    await expect(jsonApiAdapter.fetch(broken, { fetch })).rejects.toThrow(/no jsonSelectors/);
  });
});
