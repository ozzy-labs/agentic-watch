import { describe, expect, it } from "vitest";
import {
  buildMetadataUrl,
  extractPackageName,
  npmRegistryAdapter,
  parsePackument,
} from "../../../src/core/feeds/npm-registry.js";
import type { FetchLike } from "../../../src/core/feeds/types.js";
import type { Source } from "../../../src/schemas/index.js";

/**
 * Build a source with the npm-registry kind. Defaults to a scoped package URL
 * because the trickiest cases (slug, encoding, id derivation) all involve the
 * scope separator.
 */
function makeSource(url = "@anthropic-ai/sdk", id = "anthropic-sdk-js"): Source {
  return {
    id,
    kind: "npm-registry",
    url,
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

/**
 * Minimal packument that mirrors the shape registry.npmjs.org returns for a
 * package with two versions. We only populate the fields the adapter touches.
 */
function packument(versions: string[]): string {
  const versionsObj: Record<string, unknown> = {};
  const timeObj: Record<string, string> = {};
  for (const [i, v] of versions.entries()) {
    versionsObj[v] = {
      name: "@anthropic-ai/sdk",
      version: v,
      description: `release ${v}`,
    };
    // Spread `time` values across distinct days so order in `versions` is
    // independent of publishedAt; this keeps the test assertions about ID
    // stability honest.
    timeObj[v] = `2026-05-${10 + i}T09:00:00.000Z`;
  }
  return JSON.stringify({
    name: "@anthropic-ai/sdk",
    versions: versionsObj,
    time: timeObj,
  });
}

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

describe("core/feeds/npm-registry — extractPackageName", () => {
  it("accepts a bare scoped package name verbatim", () => {
    expect(extractPackageName("@anthropic-ai/sdk")).toBe("@anthropic-ai/sdk");
  });

  it("accepts a bare unscoped package name verbatim", () => {
    expect(extractPackageName("react")).toBe("react");
  });

  it("parses the public npmjs.com URL for unscoped packages", () => {
    expect(extractPackageName("https://www.npmjs.com/package/react")).toBe("react");
    expect(extractPackageName("https://npmjs.com/package/react")).toBe("react");
  });

  it("parses scoped packages out of the public URL", () => {
    expect(extractPackageName("https://www.npmjs.com/package/@anthropic-ai/sdk")).toBe(
      "@anthropic-ai/sdk",
    );
  });

  it("strips trailing /v/<version> path segments", () => {
    expect(extractPackageName("https://www.npmjs.com/package/react/v/19.0.0")).toBe("react");
  });

  it("rejects HTTP(S) URLs that point somewhere other than npmjs.com", () => {
    expect(extractPackageName("https://example.com/package/react")).toBeUndefined();
  });

  it("rejects an empty / whitespace input", () => {
    expect(extractPackageName("")).toBeUndefined();
    expect(extractPackageName("   ")).toBeUndefined();
  });
});

describe("core/feeds/npm-registry — buildMetadataUrl", () => {
  it("keeps the scope separator unescaped (registry requires it)", () => {
    // `@anthropic-ai%2Fsdk` would 404 — the registry only resolves the literal
    // slash form. This test pins that contract.
    expect(buildMetadataUrl("@anthropic-ai/sdk")).toBe(
      "https://registry.npmjs.org/@anthropic-ai/sdk",
    );
  });

  it("handles unscoped names", () => {
    expect(buildMetadataUrl("react")).toBe("https://registry.npmjs.org/react");
  });
});

describe("core/feeds/npm-registry — parsePackument", () => {
  it("normalizes every version into an Item with the contract id shape", () => {
    const items = parsePackument(
      packument(["0.1.0", "0.2.0"]),
      makeSource(),
      "2026-05-12T10:00:00.000Z",
      "@anthropic-ai/sdk",
    );
    expect(items).toHaveLength(2);
    // id is `<slug>-<8 hex>` per ADR-0002. Slug source is `<pkg>@<version>`.
    expect(items[0]?.id).toMatch(/^anthropic-ai-sdk-0-1-0-[0-9a-f]{8}$/);
    expect(items[1]?.id).toMatch(/^anthropic-ai-sdk-0-2-0-[0-9a-f]{8}$/);
    // Distinct stableKeys → distinct hash suffixes → distinct ids.
    expect(items[0]?.id).not.toBe(items[1]?.id);
    expect(items[0]).toMatchObject({
      sourceId: "anthropic-sdk-js",
      title: "@anthropic-ai/sdk@0.1.0",
      url: "https://www.npmjs.com/package/@anthropic-ai/sdk/v/0.1.0",
      fetchedAt: "2026-05-12T10:00:00.000Z",
      publishedAt: "2026-05-10T09:00:00.000Z",
      summary: "release 0.1.0",
    });
  });

  it("derives the same id on repeated parses (stable across re-fetches)", () => {
    const first = parsePackument(
      packument(["1.0.0"]),
      makeSource(),
      "2026-05-12T10:00:00.000Z",
      "@anthropic-ai/sdk",
    );
    const second = parsePackument(
      packument(["1.0.0"]),
      makeSource(),
      "2026-05-13T10:00:00.000Z",
      "@anthropic-ai/sdk",
    );
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("returns an empty array when `versions` is missing", () => {
    const body = JSON.stringify({ name: "@anthropic-ai/sdk", time: {} });
    expect(
      parsePackument(body, makeSource(), "2026-05-12T10:00:00.000Z", "@anthropic-ai/sdk"),
    ).toEqual([]);
  });

  it("returns an empty array when `versions` is an empty object", () => {
    const body = JSON.stringify({ name: "@anthropic-ai/sdk", versions: {}, time: {} });
    expect(
      parsePackument(body, makeSource(), "2026-05-12T10:00:00.000Z", "@anthropic-ai/sdk"),
    ).toEqual([]);
  });

  it("skips versions listed only in `time` (tombstoned) and keeps the rest", () => {
    // Build a packument where one version exists only in `time`; the adapter
    // must drop it without erroring on the surrounding entries.
    const body = JSON.stringify({
      name: "react",
      versions: {
        "19.0.0": { name: "react", version: "19.0.0", description: "x" },
      },
      time: {
        "19.0.0": "2026-05-10T09:00:00.000Z",
        "0.0.0-tombstone": "2020-01-01T00:00:00.000Z",
      },
    });
    const items = parsePackument(
      body,
      makeSource("react", "react"),
      "2026-05-12T10:00:00Z",
      "react",
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("react@19.0.0");
  });

  it("throws a readable error on malformed JSON", () => {
    expect(() =>
      parsePackument("not json", makeSource(), "2026-05-12T10:00:00.000Z", "@anthropic-ai/sdk"),
    ).toThrow(/failed to parse JSON/);
  });
});

describe("core/feeds/npm-registry — adapter", () => {
  it("issues GET against registry.npmjs.org with the package name unescaped", async () => {
    let observedUrl: string | undefined;
    let observedHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      observedUrl = String(url);
      observedHeaders = init?.headers;
      return {
        status: 200,
        headers: {
          get: (n) => (n.toLowerCase() === "etag" ? '"v1"' : null),
        },
        text: async () => packument(["1.0.0"]),
      };
    };
    const result = await npmRegistryAdapter.fetch(makeSource(), { fetch: fetchImpl });
    expect(observedUrl).toBe("https://registry.npmjs.org/@anthropic-ai/sdk");
    expect(observedHeaders?.accept).toBe("application/json");
    expect(observedHeaders?.["user-agent"]).toMatch(/^agentic-watch/);
    expect(result.notModified).toBeFalsy();
    expect(result.items).toHaveLength(1);
    expect(result.state.lastEtag).toBe('"v1"');
    expect(result.state.lastFetchedAt).toBeTypeOf("string");
  });

  it("forwards lastEtag as If-None-Match for conditional GET", async () => {
    let observedHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      observedHeaders = init?.headers;
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => packument(["1.0.0"]),
      };
    };
    await npmRegistryAdapter.fetch(makeSource(), {
      fetch: fetchImpl,
      state: { sourceId: "anthropic-sdk-js", lastEtag: '"old"', lastSeenIds: [] },
    });
    expect(observedHeaders?.["if-none-match"]).toBe('"old"');
  });

  it("returns notModified=true on HTTP 304 and preserves the previous etag", async () => {
    const result = await npmRegistryAdapter.fetch(makeSource(), {
      fetch: mockFetch([{ status: 304, headers: { ETag: '"keep"' } }]),
      state: { sourceId: "anthropic-sdk-js", lastEtag: '"keep"', lastSeenIds: ["x"] },
    });
    expect(result.notModified).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.state.lastEtag).toBe('"keep"');
  });

  it("throws a readable error on HTTP 404 (unknown package)", async () => {
    await expect(
      npmRegistryAdapter.fetch(makeSource("@does-not/exist", "nope"), {
        fetch: mockFetch([{ status: 404, body: "not found" }]),
      }),
    ).rejects.toThrow(/HTTP 404|package not found/);
  });

  it("throws on other non-2xx responses", async () => {
    await expect(
      npmRegistryAdapter.fetch(makeSource(), {
        fetch: mockFetch([{ status: 500, body: "boom" }]),
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("rejects an unsupported url (non-npmjs HTTPS URL)", async () => {
    await expect(
      npmRegistryAdapter.fetch(makeSource("https://example.com/package/sdk", "sdk"), {
        fetch: mockFetch([{ status: 200, body: "{}" }]),
      }),
    ).rejects.toThrow(/cannot extract package name/);
  });

  it("dedupes previously seen versions when paired with the watcher's lastSeenIds", async () => {
    // The watcher (not the adapter) is responsible for the actual dedup, but
    // we sanity-check the contract: every fetched item ships with a stable id
    // that the watcher can subtract from `state.lastSeenIds`.
    const first = await npmRegistryAdapter.fetch(makeSource(), {
      fetch: mockFetch([
        {
          status: 200,
          body: packument(["1.0.0"]),
          headers: { ETag: '"v1"' },
        },
      ]),
    });
    const second = await npmRegistryAdapter.fetch(makeSource(), {
      fetch: mockFetch([
        {
          status: 200,
          body: packument(["1.0.0", "1.1.0"]),
          headers: { ETag: '"v2"' },
        },
      ]),
    });
    const firstIds = new Set(first.items.map((i) => i.id));
    const newOnSecondRun = second.items.filter((i) => !firstIds.has(i.id));
    // First run yielded only 1.0.0; second run should produce one *new* id for
    // 1.1.0 while 1.0.0's id stays byte-stable so the watcher can dedup it.
    expect(newOnSecondRun).toHaveLength(1);
    expect(newOnSecondRun[0]?.title).toBe("@anthropic-ai/sdk@1.1.0");
  });
});
