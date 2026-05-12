import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchReleases, parseOwnerRepo } from "../../../src/core/feeds/github-api.js";
import { githubReleasesAdapter } from "../../../src/core/feeds/github-releases.js";
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
    id: "anthropic-sdk-python",
    kind: "github-releases",
    url: "https://github.com/anthropics/anthropic-sdk-python",
    tags: [],
    filters: {
      keywords: [],
      excludeKeywords: [],
      matchMode: "word",
      matchFields: ["title", "summary"],
      caseSensitive: false,
    },
    ...overrides,
  };
}

const RELEASE_1 = {
  id: 1001,
  tag_name: "v0.1.0",
  name: "v0.1.0 Initial release",
  body: "First release notes",
  draft: false,
  prerelease: false,
  html_url: "https://github.com/anthropics/anthropic-sdk-python/releases/tag/v0.1.0",
  published_at: "2026-05-10T12:00:00Z",
  created_at: "2026-05-10T11:00:00Z",
};

const RELEASE_2 = {
  id: 1002,
  tag_name: "v0.2.0",
  name: "",
  body: null,
  draft: false,
  prerelease: true,
  html_url: "https://github.com/anthropics/anthropic-sdk-python/releases/tag/v0.2.0",
  published_at: "2026-05-12T15:30:00Z",
  created_at: "2026-05-12T15:00:00Z",
};

describe("core/feeds/github-api — parseOwnerRepo", () => {
  it("parses full GitHub URL", () => {
    expect(parseOwnerRepo("https://github.com/anthropics/anthropic-sdk-python")).toEqual({
      owner: "anthropics",
      repo: "anthropic-sdk-python",
    });
  });

  it("parses owner/repo shorthand", () => {
    expect(parseOwnerRepo("anthropics/anthropic-sdk-python")).toEqual({
      owner: "anthropics",
      repo: "anthropic-sdk-python",
    });
  });

  it("strips trailing path segments", () => {
    expect(parseOwnerRepo("https://github.com/anthropics/anthropic-sdk-python/tree/main")).toEqual({
      owner: "anthropics",
      repo: "anthropic-sdk-python",
    });
  });

  it("strips .git suffix", () => {
    expect(parseOwnerRepo("https://github.com/foo/bar.git")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("handles api.github.com URLs", () => {
    expect(parseOwnerRepo("https://api.github.com/repos/foo/bar")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("throws on malformed input", () => {
    expect(() => parseOwnerRepo("")).toThrow();
    expect(() => parseOwnerRepo("only-owner")).toThrow();
    expect(() => parseOwnerRepo("https://github.com/single")).toThrow();
  });
});

describe("core/feeds/github-api — fetchReleases", () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    // Ensure tests do not pick up the host's real token.
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (originalToken != null) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    vi.restoreAllMocks();
  });

  it("issues authenticated GET when token is provided", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: JSON.stringify([RELEASE_1]),
        headers: {
          ETag: '"abc"',
          "X-RateLimit-Remaining": "4999",
          "X-RateLimit-Limit": "5000",
        },
      },
    ]);
    const warn = vi.fn();
    const result = await fetchReleases("anthropics", "anthropic-sdk-python", {
      fetch,
      token: "ghp_test",
      warn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers?.authorization).toBe("Bearer ghp_test");
    expect(calls[0]?.headers?.accept).toContain("application/vnd.github+json");
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/anthropics/anthropic-sdk-python/releases",
    );
    expect(result.releases).toHaveLength(1);
    expect(result.etag).toBe('"abc"');
    expect(result.rateLimit.remaining).toBe(4999);
    expect(warn).not.toHaveBeenCalled();
  });

  it("issues anonymous GET when no token is provided", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: "[]",
        headers: { "X-RateLimit-Remaining": "59" },
      },
    ]);
    await fetchReleases("foo", "bar", { fetch });
    expect(calls[0]?.headers?.authorization).toBeUndefined();
  });

  it("emits a warning when X-RateLimit-Remaining is low", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: "[]",
        headers: {
          "X-RateLimit-Remaining": "5",
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Reset": "1893456000",
        },
      },
    ]);
    const warn = vi.fn();
    await fetchReleases("foo", "bar", { fetch, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0];
    expect(msg).toMatch(/rate limit low/);
    expect(msg).toMatch(/5\/60/);
    expect(msg).toMatch(/GITHUB_TOKEN/); // anonymous → tells user to set token
  });

  it("does not mention GITHUB_TOKEN in the warning when authenticated", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: "[]",
        headers: {
          "X-RateLimit-Remaining": "5",
          "X-RateLimit-Limit": "5000",
        },
      },
    ]);
    const warn = vi.fn();
    await fetchReleases("foo", "bar", { fetch, token: "tok", warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toMatch(/GITHUB_TOKEN/);
  });

  it("returns notModified=true on HTTP 304", async () => {
    const { fetch } = mockFetch([
      {
        status: 304,
        headers: { ETag: '"keep"', "X-RateLimit-Remaining": "5000" },
      },
    ]);
    const result = await fetchReleases("foo", "bar", { fetch, etag: '"keep"' });
    expect(result.notModified).toBe(true);
    expect(result.status).toBe(304);
    expect(result.etag).toBe('"keep"');
    expect(result.releases).toEqual([]);
  });

  it("sends If-None-Match when etag is provided", async () => {
    const { fetch, calls } = mockFetch([
      { status: 304, headers: { "X-RateLimit-Remaining": "5000" } },
    ]);
    await fetchReleases("foo", "bar", { fetch, etag: '"old"' });
    expect(calls[0]?.headers?.["if-none-match"]).toBe('"old"');
  });

  it("throws a clear error on 403 + remaining=0", async () => {
    const { fetch } = mockFetch([
      {
        status: 403,
        body: '{"message":"API rate limit exceeded"}',
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1893456000",
        },
      },
    ]);
    await expect(fetchReleases("foo", "bar", { fetch })).rejects.toThrow(/rate limit exhausted/);
  });

  it("throws on 404 with repo context", async () => {
    const { fetch } = mockFetch([{ status: 404, body: '{"message":"Not Found"}' }]);
    await expect(fetchReleases("foo", "bar", { fetch })).rejects.toThrow(
      /repository not found.*foo\/bar/,
    );
  });

  it("throws on 401 with auth hint", async () => {
    const { fetch } = mockFetch([{ status: 401 }]);
    await expect(fetchReleases("foo", "bar", { fetch })).rejects.toThrow(/authentication failed/);
  });

  it("throws on non-array JSON", async () => {
    const { fetch } = mockFetch([{ status: 200, body: '{"oops":true}' }]);
    await expect(fetchReleases("foo", "bar", { fetch })).rejects.toThrow(/expected JSON array/);
  });

  it("throws on malformed JSON", async () => {
    const { fetch } = mockFetch([{ status: 200, body: "not-json" }]);
    await expect(fetchReleases("foo", "bar", { fetch })).rejects.toThrow(/failed to parse JSON/);
  });

  it("falls back to process.env.GITHUB_TOKEN when option is absent", async () => {
    process.env.GITHUB_TOKEN = "ghp_env_test";
    const { fetch, calls } = mockFetch([{ status: 200, body: "[]" }]);
    await fetchReleases("foo", "bar", { fetch });
    expect(calls[0]?.headers?.authorization).toBe("Bearer ghp_env_test");
  });

  it("filters out malformed release objects defensively", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify([RELEASE_1, { id: "not-a-number" }, null, RELEASE_2]),
      },
    ]);
    const result = await fetchReleases("foo", "bar", { fetch });
    expect(result.releases).toHaveLength(2);
  });
});

describe("core/feeds/github-releases — adapter", () => {
  it("normalizes a release into an Item", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify([RELEASE_1]),
        headers: { ETag: '"v1"', "X-RateLimit-Remaining": "5000" },
      },
    ]);
    const result = await githubReleasesAdapter.fetch(makeSource(), { fetch });
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.title).toBe("v0.1.0 Initial release");
    expect(item?.url).toBe(RELEASE_1.html_url);
    expect(item?.summary).toBe("First release notes");
    expect(item?.publishedAt).toBe("2026-05-10T12:00:00.000Z");
    expect(item?.sourceId).toBe("anthropic-sdk-python");
    expect(item?.id).toMatch(/^v0-1-0-initial-release-[0-9a-f]{8}$/);
    expect(result.state.lastEtag).toBe('"v1"');
    expect(result.notModified).toBeFalsy();
  });

  it("falls back to tag_name for title when name is empty", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: JSON.stringify([RELEASE_2]),
        headers: { "X-RateLimit-Remaining": "5000" },
      },
    ]);
    const result = await githubReleasesAdapter.fetch(makeSource(), { fetch });
    expect(result.items[0]?.title).toBe("v0.2.0");
    expect(result.items[0]?.id).toMatch(/^v0-2-0-[0-9a-f]{8}$/);
    expect(result.items[0]?.summary).toBeUndefined();
  });

  it("preserves the full release as Item.raw", async () => {
    const { fetch } = mockFetch([{ status: 200, body: JSON.stringify([RELEASE_1]) }]);
    const result = await githubReleasesAdapter.fetch(makeSource(), { fetch });
    expect(result.items[0]?.raw).toMatchObject({
      id: RELEASE_1.id,
      tag_name: RELEASE_1.tag_name,
    });
  });

  it("returns an empty Item list for an empty releases response", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: "[]",
        headers: { ETag: '"empty"', "X-RateLimit-Remaining": "5000" },
      },
    ]);
    const result = await githubReleasesAdapter.fetch(makeSource(), { fetch });
    expect(result.items).toEqual([]);
    expect(result.state.lastEtag).toBe('"empty"');
  });

  it("handles multiple releases and produces distinct ids", async () => {
    const { fetch } = mockFetch([{ status: 200, body: JSON.stringify([RELEASE_1, RELEASE_2]) }]);
    const result = await githubReleasesAdapter.fetch(makeSource(), { fetch });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.id).not.toBe(result.items[1]?.id);
  });

  it("derives stable ids across re-fetches", async () => {
    const make = () => mockFetch([{ status: 200, body: JSON.stringify([RELEASE_1, RELEASE_2]) }]);
    const first = await githubReleasesAdapter.fetch(makeSource(), { fetch: make().fetch });
    const second = await githubReleasesAdapter.fetch(makeSource(), { fetch: make().fetch });
    expect(first.items[0]?.id).toBe(second.items[0]?.id);
    expect(first.items[1]?.id).toBe(second.items[1]?.id);
  });

  it("produces different ids when tag_name and release id differ", async () => {
    // Same title and url shape but different release id — stableKey should diverge.
    const recreated = { ...RELEASE_1, id: 9999 };
    const { fetch: fetchA } = mockFetch([{ status: 200, body: JSON.stringify([RELEASE_1]) }]);
    const { fetch: fetchB } = mockFetch([{ status: 200, body: JSON.stringify([recreated]) }]);
    const a = await githubReleasesAdapter.fetch(makeSource(), { fetch: fetchA });
    const b = await githubReleasesAdapter.fetch(makeSource(), { fetch: fetchB });
    expect(a.items[0]?.id).not.toBe(b.items[0]?.id);
  });

  it("returns notModified=true and bumps lastFetchedAt on 304", async () => {
    const { fetch } = mockFetch([
      {
        status: 304,
        headers: { ETag: '"keep"', "X-RateLimit-Remaining": "5000" },
      },
    ]);
    const result = await githubReleasesAdapter.fetch(makeSource(), {
      fetch,
      state: { sourceId: "anthropic-sdk-python", lastEtag: '"keep"', lastSeenIds: [] },
    });
    expect(result.notModified).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.state.lastEtag).toBe('"keep"');
    expect(result.state.lastFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts owner/repo shorthand URLs", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: "[]" }]);
    await githubReleasesAdapter.fetch(makeSource({ url: "anthropics/anthropic-sdk-python" }), {
      fetch,
    });
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/anthropics/anthropic-sdk-python/releases",
    );
  });

  it("propagates rate-limit errors", async () => {
    const { fetch } = mockFetch([
      {
        status: 403,
        body: '{"message":"API rate limit exceeded"}',
        headers: { "X-RateLimit-Remaining": "0" },
      },
    ]);
    await expect(githubReleasesAdapter.fetch(makeSource(), { fetch })).rejects.toThrow(
      /rate limit exhausted/,
    );
  });
});
