import { describe, expect, it } from "vitest";
import {
  CONTENT_HASH_PREFIX,
  contentHash,
  parseHtmlDocument,
} from "../../../src/core/feeds/_html-common.js";
import type { Source } from "../../../src/schemas/index.js";

/**
 * Unit tests for the shared HTML parsing primitives extracted from
 * `core/feeds/html.ts` per ADR-0010 §D1. The full behavior matrix
 * (datetime fallbacks, missing fields, tag collection) is exercised in
 * `tests/core/feeds/html.test.ts` against the same `parseHtmlDocument`
 * function; this file pins the *direct* import surface so a future move /
 * rename of `_html-common.ts` is caught immediately.
 */

const HTML_FIXTURE = `<!doctype html>
<html><body>
  <main>
    <article class="post">
      <h2><a href="/changelog/alpha">Alpha</a></h2>
      <p class="summary">First entry</p>
    </article>
    <article class="post">
      <h2><a href="https://example.com/changelog/beta">Beta</a></h2>
      <p class="summary">Second entry</p>
    </article>
  </main>
</body></html>`;

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "spa-example",
    kind: "html-js",
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
    },
    trustLevel: "untrusted",
    ...overrides,
  };
}

describe("core/feeds/_html-common — parseHtmlDocument", () => {
  it("parses items via selectors regardless of source kind", () => {
    // The parser does not care whether the source is `html` or `html-js` —
    // both adapters feed the same serialized HTML through this function.
    const items = parseHtmlDocument(HTML_FIXTURE, makeSource(), "2026-05-17T10:00:00.000Z");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Alpha",
      url: "https://example.com/changelog/alpha",
      summary: "First entry",
      sourceId: "spa-example",
    });
    expect(items[1]?.url).toBe("https://example.com/changelog/beta");
  });

  it("resolves relative links against the source URL", () => {
    const items = parseHtmlDocument(HTML_FIXTURE, makeSource(), "2026-05-17T10:00:00.000Z");
    // `/changelog/alpha` must be absolutized — `ItemSchema.url` is strict.
    expect(items[0]?.url.startsWith("https://example.com/")).toBe(true);
  });

  it("throws a readable error when source has no selectors", () => {
    const source = { ...makeSource(), selectors: undefined } as Source;
    expect(() => parseHtmlDocument(HTML_FIXTURE, source, "2026-05-17T10:00:00.000Z")).toThrow(
      /no selectors/,
    );
  });
});

describe("core/feeds/_html-common — contentHash", () => {
  it("returns a sha256-prefixed hex digest", () => {
    const hash = contentHash("hello");
    expect(hash.startsWith(CONTENT_HASH_PREFIX)).toBe(true);
    // sha256 hex digest is 64 chars; the prefix is 7 chars (`sha256:`).
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic for identical input", () => {
    // Both adapters rely on this property for dedup: re-fetching the same
    // page must produce the same marker so `lastEtag` comparison short-circuits.
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("differs for distinct inputs", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });

  it("exposes the `sha256:` prefix as a constant for cross-module checks", () => {
    // `html.ts` checks `startsWith(CONTENT_HASH_PREFIX)` before forwarding
    // `lastEtag` as an HTTP `If-None-Match`; pin the format here.
    expect(CONTENT_HASH_PREFIX).toBe("sha256:");
  });
});
