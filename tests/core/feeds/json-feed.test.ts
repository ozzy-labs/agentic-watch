import { describe, expect, it } from "vitest";
import {
  extractNextUrl,
  jsonFeedAdapter,
  parseJsonFeed,
} from "../../../src/core/feeds/json-feed.js";
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
    if (!next) throw new Error("no more mock responses");
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

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "example-jf",
    kind: "json-feed",
    url: "https://example.com/feed.json",
    tags: [],
    filters: {
      keywords: [],
      excludeKeywords: [],
      matchMode: "word",
      matchFields: ["title", "summary"],
      caseSensitive: false,
    },
    trustLevel: "untrusted",
    ...overrides,
  };
}

const FEED_1_0 = JSON.stringify({
  version: "https://jsonfeed.org/version/1",
  title: "Example Microblog",
  home_page_url: "https://example.com",
  feed_url: "https://example.com/feed.json",
  items: [
    {
      id: "post-1",
      url: "https://example.com/posts/hello",
      title: "Hello World",
      content_text: "First post text",
      date_published: "2026-05-12T09:00:00Z",
      tags: ["intro", "blog"],
    },
    {
      id: "post-2",
      url: "https://example.com/posts/second",
      title: "Second Post",
      content_html: "<p>Second post body</p>",
      date_published: "2026-05-13T10:00:00Z",
    },
  ],
});

const FEED_1_1 = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "Example 1.1 Feed",
  items: [
    {
      id: "v1.1-a",
      url: "https://example.com/1.1/a",
      title: "V1.1 Entry",
      content_html: "<p>html body</p>",
      content_text: "text body",
      date_published: "2026-05-14T12:00:00Z",
      tags: ["release"],
    },
  ],
});

describe("core/feeds/json-feed — parser", () => {
  it("parses a JSON Feed 1.0 document", () => {
    const items = parseJsonFeed(FEED_1_0, makeSource(), "2026-05-15T10:00:00.000Z");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Hello World",
      url: "https://example.com/posts/hello",
      summary: "First post text",
      sourceId: "example-jf",
      fetchedAt: "2026-05-15T10:00:00.000Z",
    });
    expect(items[0]?.id).toMatch(/^hello-world-[0-9a-f]{8}$/);
    expect(items[0]?.publishedAt).toBe("2026-05-12T09:00:00.000Z");
    expect(items[1]?.summary).toBe("<p>Second post body</p>");
    expect(items[0]?.id).not.toBe(items[1]?.id);
  });

  it("parses a JSON Feed 1.1 document", () => {
    const items = parseJsonFeed(FEED_1_1, makeSource(), "2026-05-15T10:00:00.000Z");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("V1.1 Entry");
    expect(items[0]?.url).toBe("https://example.com/1.1/a");
  });

  it("prefers content_html when both content_html and content_text are present", () => {
    const items = parseJsonFeed(FEED_1_1, makeSource(), "2026-05-15T10:00:00.000Z");
    // FEED_1_1's item has both content_html and content_text — html wins per issue spec.
    expect(items[0]?.summary).toBe("<p>html body</p>");
  });

  it("uses content_text when content_html is absent", () => {
    const items = parseJsonFeed(FEED_1_0, makeSource(), "2026-05-15T10:00:00.000Z");
    expect(items[0]?.summary).toBe("First post text");
  });

  it("falls back to top-level summary when neither content_* is present", () => {
    const doc = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [
        {
          id: "summary-only",
          url: "https://example.com/s",
          title: "Summary Only",
          summary: "short summary text",
        },
      ],
    });
    const items = parseJsonFeed(doc, makeSource(), "2026-05-15T10:00:00.000Z");
    expect(items[0]?.summary).toBe("short summary text");
  });

  it("normalizes tags into raw (drops non-strings and empties)", () => {
    const doc = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [
        {
          id: "t1",
          url: "https://example.com/t",
          title: "Tag Test",
          tags: ["valid", "", "  ", 123, null, "another"],
        },
      ],
    });
    const items = parseJsonFeed(doc, makeSource(), "2026-05-15T10:00:00.000Z");
    const raw = items[0]?.raw as { tags?: unknown };
    expect(raw?.tags).toEqual(["valid", "another"]);
  });

  it("treats missing tags as an empty array", () => {
    const doc = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [{ id: "t2", url: "https://example.com/t2", title: "No Tags" }],
    });
    const items = parseJsonFeed(doc, makeSource(), "2026-05-15T10:00:00.000Z");
    const raw = items[0]?.raw as { tags?: unknown };
    expect(raw?.tags).toEqual([]);
  });

  it("falls back to url-derived id when item.id is missing", () => {
    const withId = parseJsonFeed(FEED_1_0, makeSource(), "2026-05-15T10:00:00.000Z");
    const noIdDoc = JSON.stringify({
      version: "https://jsonfeed.org/version/1",
      items: [
        {
          // id removed
          url: "https://example.com/posts/hello",
          title: "Hello World",
          content_text: "First post text",
          date_published: "2026-05-12T09:00:00Z",
        },
      ],
    });
    const noId = parseJsonFeed(noIdDoc, makeSource(), "2026-05-15T10:00:00.000Z");
    expect(noId[0]?.id).toMatch(/^hello-world-[0-9a-f]{8}$/);
    // stableKey shifts from publisherId to url, so the hash suffix differs.
    expect(noId[0]?.id).not.toBe(withId[0]?.id);
  });

  it("derives stable ids across re-parses (same input → same id)", () => {
    const a = parseJsonFeed(FEED_1_0, makeSource(), "2026-05-15T10:00:00.000Z");
    const b = parseJsonFeed(FEED_1_0, makeSource(), "2026-05-16T12:00:00.000Z");
    expect(a[0]?.id).toBe(b[0]?.id);
    expect(a[1]?.id).toBe(b[1]?.id);
  });

  it("drops items missing a url (Item schema requires url)", () => {
    const doc = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [
        { id: "no-url", title: "No URL" },
        { id: "good", url: "https://example.com/good", title: "Good" },
      ],
    });
    const items = parseJsonFeed(doc, makeSource(), "2026-05-15T10:00:00.000Z");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Good");
  });

  it("drops items whose date_published is unparseable but keeps the rest", () => {
    const doc = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [
        {
          id: "bad-date",
          url: "https://example.com/bd",
          title: "Bad Date",
          date_published: "not a real date",
        },
      ],
    });
    const items = parseJsonFeed(doc, makeSource(), "2026-05-15T10:00:00.000Z");
    expect(items).toHaveLength(1);
    expect(items[0]?.publishedAt).toBeUndefined();
  });

  it("accepts ISO 8601 dates with timezone offsets", () => {
    const doc = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [
        {
          id: "tz",
          url: "https://example.com/tz",
          title: "TZ Test",
          date_published: "2026-05-12T09:00:00+09:00",
        },
      ],
    });
    const items = parseJsonFeed(doc, makeSource(), "2026-05-15T10:00:00.000Z");
    expect(items[0]?.publishedAt).toBe("2026-05-12T00:00:00.000Z");
  });

  it("throws on missing version field (fail-soft at adapter boundary)", () => {
    const doc = JSON.stringify({
      items: [{ id: "x", url: "https://example.com/x", title: "X" }],
    });
    expect(() => parseJsonFeed(doc, makeSource(), "2026-05-15T10:00:00.000Z")).toThrow(
      /unsupported or missing 'version'/,
    );
  });

  it("throws on invalid version string", () => {
    const doc = JSON.stringify({
      version: "https://jsonfeed.org/version/2",
      items: [],
    });
    expect(() => parseJsonFeed(doc, makeSource(), "2026-05-15T10:00:00.000Z")).toThrow(
      /unsupported or missing 'version'/,
    );
  });

  it("throws a readable error on malformed JSON", () => {
    expect(() => parseJsonFeed("not-json", makeSource(), "2026-05-15T10:00:00.000Z")).toThrow(
      /failed to parse JSON/,
    );
  });

  it("returns an empty array when items is missing or not an array", () => {
    const noItems = JSON.stringify({ version: "https://jsonfeed.org/version/1.1" });
    expect(parseJsonFeed(noItems, makeSource(), "2026-05-15T10:00:00.000Z")).toEqual([]);
    const wrongShape = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: "not-an-array",
    });
    expect(parseJsonFeed(wrongShape, makeSource(), "2026-05-15T10:00:00.000Z")).toEqual([]);
  });

  it("tolerates an empty / blank title (hash-only id)", () => {
    const doc = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [{ id: "no-title", url: "https://example.com/nt", title: "   " }],
    });
    const items = parseJsonFeed(doc, makeSource(), "2026-05-15T10:00:00.000Z");
    expect(items[0]?.id).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("core/feeds/json-feed — extractNextUrl", () => {
  it("returns the next_url string when present", () => {
    const body = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [],
      next_url: "https://example.com/feed.json?page=2",
    });
    expect(extractNextUrl(body)).toBe("https://example.com/feed.json?page=2");
  });

  it("returns undefined when next_url is missing", () => {
    const body = JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: [] });
    expect(extractNextUrl(body)).toBeUndefined();
  });

  it("returns undefined when next_url is empty or non-string", () => {
    expect(
      extractNextUrl(
        JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: [], next_url: "" }),
      ),
    ).toBeUndefined();
    expect(
      extractNextUrl(
        JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: [], next_url: 42 }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined on malformed JSON instead of throwing", () => {
    expect(extractNextUrl("oops")).toBeUndefined();
  });
});

describe("core/feeds/json-feed — adapter", () => {
  it("fetches a single-page feed and returns items + state", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: FEED_1_1, headers: { ETag: '"abc"', "Last-Modified": "Fri" } },
    ]);
    const result = await jsonFeedAdapter.fetch(makeSource(), { fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers?.accept).toMatch(/application\/feed\+json/);
    expect(result.items).toHaveLength(1);
    expect(result.state.lastEtag).toBe('"abc"');
    expect(result.state.lastModified).toBe("Fri");
    expect(result.notModified).toBeFalsy();
  });

  it("sends conditional headers when previous state has etag / lastModified", async () => {
    let observedHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      observedHeaders = init?.headers;
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => FEED_1_1,
      };
    };
    await jsonFeedAdapter.fetch(makeSource(), {
      fetch: fetchImpl,
      state: {
        sourceId: "example-jf",
        lastEtag: '"prev"',
        lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
        lastSeenIds: [],
      },
    });
    expect(observedHeaders?.["if-none-match"]).toBe('"prev"');
    expect(observedHeaders?.["if-modified-since"]).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
  });

  it("returns notModified=true on HTTP 304", async () => {
    const { fetch } = mockFetch([{ status: 304, headers: { ETag: '"keep"' } }]);
    const result = await jsonFeedAdapter.fetch(makeSource(), {
      fetch,
      state: { sourceId: "example-jf", lastEtag: '"keep"', lastSeenIds: ["x"] },
    });
    expect(result.notModified).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.state.lastEtag).toBe('"keep"');
  });

  it("walks next_url pagination and accumulates items", async () => {
    const page1 = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [{ id: "a", url: "https://example.com/a", title: "A" }],
      next_url: "https://example.com/feed.json?page=2",
    });
    const page2 = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [{ id: "b", url: "https://example.com/b", title: "B" }],
      next_url: "https://example.com/feed.json?page=3",
    });
    const page3 = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [{ id: "c", url: "https://example.com/c", title: "C" }],
    });
    const { fetch, calls } = mockFetch([
      { status: 200, body: page1 },
      { status: 200, body: page2 },
      { status: 200, body: page3 },
    ]);
    const result = await jsonFeedAdapter.fetch(makeSource(), { fetch });
    expect(calls.map((c) => c.url)).toEqual([
      "https://example.com/feed.json",
      "https://example.com/feed.json?page=2",
      "https://example.com/feed.json?page=3",
    ]);
    expect(result.items.map((i) => i.title)).toEqual(["A", "B", "C"]);
  });

  it("breaks the pagination loop on a cycle (next_url already visited)", async () => {
    const cyclical = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      items: [{ id: "a", url: "https://example.com/a", title: "A" }],
      next_url: "https://example.com/feed.json",
    });
    const { fetch, calls } = mockFetch([{ status: 200, body: cyclical }]);
    const result = await jsonFeedAdapter.fetch(makeSource(), { fetch });
    expect(calls).toHaveLength(1);
    expect(result.items).toHaveLength(1);
  });

  it("throws on a non-2xx, non-304 response (after retry exhaustion)", async () => {
    // The shared fetch wrapper retries 5xx, so we have to script three 5xx
    // responses to exhaust the default retry budget before the adapter's
    // own HTTP-status error fires.
    const { fetch } = mockFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    await expect(jsonFeedAdapter.fetch(makeSource(), { fetch })).rejects.toThrow(/HTTP 500/);
  });

  it("throws on malformed JSON body", async () => {
    const { fetch } = mockFetch([{ status: 200, body: "not-json" }]);
    await expect(jsonFeedAdapter.fetch(makeSource(), { fetch })).rejects.toThrow(
      /failed to parse JSON/,
    );
  });

  it("throws on a body whose version is missing", async () => {
    const { fetch } = mockFetch([{ status: 200, body: JSON.stringify({ items: [] }) }]);
    await expect(jsonFeedAdapter.fetch(makeSource(), { fetch })).rejects.toThrow(
      /unsupported or missing 'version'/,
    );
  });

  it("registers itself for kind 'json-feed'", () => {
    expect(jsonFeedAdapter.kind).toBe("json-feed");
  });
});
