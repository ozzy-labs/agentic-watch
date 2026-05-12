import { describe, expect, it } from "vitest";
import { htmlAdapter, parseHtmlDocument } from "../../../src/core/feeds/html.js";
import type { FetchLike } from "../../../src/core/feeds/types.js";
import type { Source } from "../../../src/schemas/index.js";

const HTML_FIXTURE = `<!doctype html>
<html><body>
  <main>
    <article class="post">
      <h2><a href="/changelog/hello">Hello World</a></h2>
      <p class="summary">First post summary</p>
      <time datetime="2026-05-12T09:00:00Z">May 12, 2026</time>
      <span class="tag">launch</span>
      <span class="tag">api</span>
    </article>
    <article class="post">
      <h2><a href="https://example.com/changelog/second">Second Post</a></h2>
      <p class="summary">Second post summary</p>
      <time datetime="2026-05-13T09:00:00Z">May 13, 2026</time>
    </article>
  </main>
</body></html>`;

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "example",
    kind: "html",
    url: "https://example.com/changelog",
    tags: [],
    filters: {
      keywords: [],
      excludeKeywords: [],
      matchMode: "word",
      matchFields: ["title", "summary"],
      caseSensitive: false,
    },
    selectors: {
      item: "article.post",
      title: "h2 a",
      link: "h2 a",
      summary: "p.summary",
      publishedAt: "time",
      tags: "span.tag",
    },
    ...overrides,
  };
}

describe("core/feeds/html — parser", () => {
  it("parses items using selectors and resolves relative links", () => {
    const items = parseHtmlDocument(HTML_FIXTURE, makeSource(), "2026-05-12T10:00:00.000Z");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Hello World",
      url: "https://example.com/changelog/hello",
      summary: "First post summary",
      sourceId: "example",
      fetchedAt: "2026-05-12T10:00:00.000Z",
      publishedAt: "2026-05-12T09:00:00.000Z",
    });
    expect(items[0]?.id).toMatch(/^hello-world-[0-9a-f]{8}$/);
    expect(items[1]?.url).toBe("https://example.com/changelog/second");
    expect(items[1]?.id).toMatch(/^second-post-[0-9a-f]{8}$/);
    // stableKey-derived hash suffix prevents collisions for items with
    // distinct urls even when slugs happen to overlap.
    expect(items[0]?.id).not.toBe(items[1]?.id);
  });

  it("derives the same id on repeated parses (stable across re-fetches)", () => {
    const first = parseHtmlDocument(HTML_FIXTURE, makeSource(), "2026-05-12T10:00:00.000Z");
    const second = parseHtmlDocument(HTML_FIXTURE, makeSource(), "2026-05-13T10:00:00.000Z");
    expect(first[0]?.id).toBe(second[0]?.id);
    expect(first[1]?.id).toBe(second[1]?.id);
  });

  it("falls back to text content when datetime attribute is missing", () => {
    const html = HTML_FIXTURE.replace(' datetime="2026-05-12T09:00:00Z"', "");
    const items = parseHtmlDocument(html, makeSource(), "2026-05-12T10:00:00.000Z");
    // "May 12, 2026" parses via new Date() to a real timestamp.
    expect(items[0]?.publishedAt).toMatch(/^2026-05-1[12]T/);
  });

  it("drops items missing a required field", () => {
    const html = HTML_FIXTURE.replace('<h2><a href="/changelog/hello">Hello World</a></h2>', "");
    const items = parseHtmlDocument(html, makeSource(), "2026-05-12T10:00:00.000Z");
    // The first article has no title/link selector match; only the second survives.
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Second Post");
  });

  it("collects tag selector matches into Item.raw.tags", () => {
    const items = parseHtmlDocument(HTML_FIXTURE, makeSource(), "2026-05-12T10:00:00.000Z");
    expect((items[0]?.raw as Record<string, unknown>).tags).toEqual(["launch", "api"]);
    // The second item has no tag spans — `raw.tags` is simply absent.
    expect((items[1]?.raw as Record<string, unknown>).tags).toBeUndefined();
  });

  it("throws when source has no selectors", () => {
    const source = { ...makeSource(), selectors: undefined } as Source;
    expect(() => parseHtmlDocument(HTML_FIXTURE, source, "2026-05-12T10:00:00.000Z")).toThrow(
      /no selectors/,
    );
  });
});

function mockFetch(
  responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
): { fetch: FetchLike; observed: Array<{ url: string; headers?: Record<string, string> }> } {
  const queue = [...responses];
  const observed: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetch: FetchLike = async (url, init) => {
    observed.push({ url: String(url), headers: init?.headers });
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
  return { fetch, observed };
}

describe("core/feeds/html — adapter", () => {
  it("forwards a real ETag as if-none-match", async () => {
    const { fetch, observed } = mockFetch([
      { status: 200, body: HTML_FIXTURE, headers: { ETag: '"new"' } },
    ]);
    const result = await htmlAdapter.fetch(makeSource(), {
      fetch,
      state: { sourceId: "example", lastEtag: '"old"', lastSeenIds: [] },
    });
    expect(observed[0]?.headers?.["if-none-match"]).toBe('"old"');
    expect(result.items).toHaveLength(2);
    expect(result.state.lastEtag).toBe('"new"');
  });

  it("does NOT forward a content-hash marker as if-none-match", async () => {
    const { fetch, observed } = mockFetch([
      { status: 200, body: HTML_FIXTURE, headers: { ETag: '"fresh"' } },
    ]);
    await htmlAdapter.fetch(makeSource(), {
      fetch,
      state: { sourceId: "example", lastEtag: "sha256:deadbeef", lastSeenIds: [] },
    });
    // sha256: markers are our own dedup state — they must never be echoed to the server.
    expect(observed[0]?.headers?.["if-none-match"]).toBeUndefined();
  });

  it("returns notModified=true on HTTP 304", async () => {
    const { fetch } = mockFetch([{ status: 304, headers: { ETag: '"keep"' } }]);
    const result = await htmlAdapter.fetch(makeSource(), {
      fetch,
      state: { sourceId: "example", lastEtag: '"keep"', lastSeenIds: ["x"] },
    });
    expect(result.notModified).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.state.lastEtag).toBe('"keep"');
  });

  it("dedups via content hash when the server omits ETag", async () => {
    const { fetch: fetch1 } = mockFetch([{ status: 200, body: HTML_FIXTURE }]);
    const first = await htmlAdapter.fetch(makeSource(), { fetch: fetch1 });
    expect(first.state.lastEtag).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.notModified).toBeFalsy();

    const { fetch: fetch2 } = mockFetch([{ status: 200, body: HTML_FIXTURE }]);
    const second = await htmlAdapter.fetch(makeSource(), {
      fetch: fetch2,
      state: { sourceId: "example", lastEtag: first.state.lastEtag ?? "", lastSeenIds: [] },
    });
    expect(second.notModified).toBe(true);
    expect(second.items).toEqual([]);
    expect(second.state.lastEtag).toBe(first.state.lastEtag);
  });

  it("throws on 5xx responses", async () => {
    const { fetch } = mockFetch([{ status: 500, body: "boom" }]);
    await expect(htmlAdapter.fetch(makeSource(), { fetch })).rejects.toThrow(/HTTP 500/);
  });

  it("throws a readable error when selectors are missing", async () => {
    const source = { ...makeSource(), selectors: undefined } as Source;
    const { fetch } = mockFetch([{ status: 200, body: HTML_FIXTURE }]);
    await expect(htmlAdapter.fetch(source, { fetch })).rejects.toThrow(/no selectors/);
  });
});
