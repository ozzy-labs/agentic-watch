import { describe, expect, it } from "vitest";
import { parseFeedXml, rssAdapter } from "../../../src/core/feeds/rss.js";
import type { FetchLike } from "../../../src/core/feeds/types.js";
import type { Source } from "../../../src/schemas/index.js";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com</link>
    <description>Test feed</description>
    <item>
      <title>Hello World</title>
      <link>https://example.com/posts/hello</link>
      <description>First post body</description>
      <guid isPermaLink="false">post-1</guid>
      <pubDate>Mon, 12 May 2026 09:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/posts/second</link>
      <description>Second post body</description>
      <guid isPermaLink="true">https://example.com/posts/second</guid>
      <pubDate>Tue, 13 May 2026 09:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>
`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <id>tag:example.com,2026:feed</id>
  <updated>2026-05-12T09:00:00Z</updated>
  <entry>
    <title>Atom Entry</title>
    <link rel="alternate" href="https://example.com/atom/1"/>
    <id>tag:example.com,2026:atom-1</id>
    <updated>2026-05-12T09:00:00Z</updated>
    <published>2026-05-12T08:00:00Z</published>
    <summary>Atom summary</summary>
  </entry>
</feed>
`;

function makeSource(): Source {
  return {
    id: "example",
    kind: "rss",
    url: "https://example.com/feed.xml",
    tags: [],
    filters: {
      keywords: [],
      excludeKeywords: [],
      matchMode: "word",
      matchFields: ["title", "summary"],
      caseSensitive: false,
    },
  };
}

describe("core/feeds/rss — parser", () => {
  it("parses RSS 2.0 items", () => {
    const items = parseFeedXml(RSS_FIXTURE, makeSource(), "2026-05-12T10:00:00.000Z");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "post-1",
      title: "Hello World",
      url: "https://example.com/posts/hello",
      summary: "First post body",
      sourceId: "example",
      fetchedAt: "2026-05-12T10:00:00.000Z",
    });
    expect(items[0].publishedAt).toBe("2026-05-12T09:00:00.000Z");
    expect(items[1].id).toBe("https://example.com/posts/second");
  });

  it("falls back to URL when guid is missing", () => {
    const xml = RSS_FIXTURE.replace(/<guid[^>]*>[^<]*<\/guid>/g, "");
    const items = parseFeedXml(xml, makeSource(), "2026-05-12T10:00:00.000Z");
    expect(items[0].id).toBe("https://example.com/posts/hello");
  });

  it("parses Atom feeds", () => {
    const items = parseFeedXml(ATOM_FIXTURE, makeSource(), "2026-05-12T10:00:00.000Z");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "tag:example.com,2026:atom-1",
      title: "Atom Entry",
      url: "https://example.com/atom/1",
      summary: "Atom summary",
    });
  });

  it("returns empty array for unrecognized XML envelopes", () => {
    expect(parseFeedXml("<other/>", makeSource(), "2026-05-12T10:00:00.000Z")).toEqual([]);
  });

  it("throws a readable error on malformed XML", () => {
    expect(() => parseFeedXml("<broken", makeSource(), "2026-05-12T10:00:00.000Z")).toThrow();
  });
});

function mockFetch(
  responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
): FetchLike {
  const queue = [...responses];
  return async () => {
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
}

describe("core/feeds/rss — adapter", () => {
  it("issues GET with conditional headers when previous state has lastEtag", async () => {
    let observedHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      observedHeaders = init?.headers;
      return {
        status: 200,
        headers: { get: (n) => (n.toLowerCase() === "etag" ? '"new"' : null) },
        text: async () => RSS_FIXTURE,
      };
    };
    const result = await rssAdapter.fetch(makeSource(), {
      fetch: fetchImpl,
      state: { sourceId: "example", lastEtag: '"old"', lastSeenIds: [] },
    });
    expect(observedHeaders?.["if-none-match"]).toBe('"old"');
    expect(result.notModified).toBeFalsy();
    expect(result.items).toHaveLength(2);
    expect(result.state.lastEtag).toBe('"new"');
  });

  it("returns notModified=true on HTTP 304", async () => {
    const result = await rssAdapter.fetch(makeSource(), {
      fetch: mockFetch([{ status: 304, headers: { ETag: '"keep"' } }]),
      state: { sourceId: "example", lastEtag: '"keep"', lastSeenIds: ["x"] },
    });
    expect(result.notModified).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.state.lastEtag).toBe('"keep"');
  });

  it("throws on non-2xx, non-304 responses", async () => {
    await expect(
      rssAdapter.fetch(makeSource(), {
        fetch: mockFetch([{ status: 500, body: "boom" }]),
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
