import { describe, expect, it } from "vitest";
import { SourceJsOptionsSchema, SourceSchema } from "../../src/schemas/source.js";

describe("schemas/source - trustLevel (ADR-0009 M4)", () => {
  it("defaults trustLevel to 'untrusted' when the field is omitted", () => {
    // Mirrors the shape of existing source YAMLs (#17) written before ADR-0009
    // M4 landed. The default must preserve the current defense-in-depth posture
    // so no migration is required.
    const result = SourceSchema.parse({
      id: "anthropic-news",
      kind: "rss",
      url: "https://anthropic.com/news/rss.xml",
    });
    expect(result.trustLevel).toBe("untrusted");
  });

  it("accepts an explicit trustLevel: 'trusted' opt-in", () => {
    const result = SourceSchema.parse({
      id: "internal-feed",
      kind: "rss",
      url: "https://example.com/feed.xml",
      trustLevel: "trusted",
    });
    expect(result.trustLevel).toBe("trusted");
  });

  it("accepts an explicit trustLevel: 'untrusted'", () => {
    const result = SourceSchema.parse({
      id: "third-party",
      kind: "rss",
      url: "https://example.com/feed.xml",
      trustLevel: "untrusted",
    });
    expect(result.trustLevel).toBe("untrusted");
  });

  it("rejects an unknown trustLevel value", () => {
    const result = SourceSchema.safeParse({
      id: "bad",
      kind: "rss",
      url: "https://example.com/feed.xml",
      trustLevel: "foo",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "trustLevel");
      expect(issue).toBeDefined();
    }
  });

  it("rejects a non-string trustLevel value", () => {
    const result = SourceSchema.safeParse({
      id: "bad",
      kind: "rss",
      url: "https://example.com/feed.xml",
      trustLevel: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("schemas/source - kind: html-js (ADR-0010)", () => {
  const baseHtmlJs = {
    id: "spa-changelog",
    kind: "html-js" as const,
    url: "https://example.com/changelog",
    selectors: {
      item: "article.post",
      title: "h2",
      link: "a",
    },
  };

  it("accepts a minimal html-js source with only required selectors", () => {
    const result = SourceSchema.parse(baseHtmlJs);
    expect(result.kind).toBe("html-js");
    expect(result.selectors?.item).toBe("article.post");
    // `js` is optional; the adapter applies defaults.
    expect(result.js).toBeUndefined();
  });

  it("requires `selectors` when kind is html-js (parity with kind: html)", () => {
    // Mirrors the html-kind enforcement: without selectors there is no way
    // to derive items from the rendered DOM, so superRefine should reject.
    const result = SourceSchema.safeParse({
      id: "spa",
      kind: "html-js",
      url: "https://example.com/",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "selectors");
      expect(issue).toBeDefined();
    }
  });

  it("parses an html-js source with full js options", () => {
    const result = SourceSchema.parse({
      ...baseHtmlJs,
      js: {
        waitFor: ".loaded",
        waitUntil: "domcontentloaded",
        timeout: 45000,
        userAgent: "feedradar-test/1.0",
      },
    });
    expect(result.js).toEqual({
      waitFor: ".loaded",
      waitUntil: "domcontentloaded",
      timeout: 45000,
      userAgent: "feedradar-test/1.0",
    });
  });

  it("rejects html-js source URLs without http(s) scheme", () => {
    const result = SourceSchema.safeParse({
      ...baseHtmlJs,
      url: "file:///etc/passwd",
    });
    expect(result.success).toBe(false);
  });
});

describe("schemas/source - kind: json-api (ADR-0012)", () => {
  const baseJsonApi = {
    id: "aws-whats-new",
    kind: "json-api" as const,
    url: "https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new",
    pagination: {
      type: "page" as const,
      param: "page",
      start: 0,
      pageSize: 100,
      pageSizeParam: "size",
      maxPages: 200,
    },
    jsonSelectors: {
      items: "$.items[*]",
      title: "$.title",
      link: "$.url",
    },
  };

  it("accepts a minimal json-api source with pagination + jsonSelectors", () => {
    const result = SourceSchema.parse(baseJsonApi);
    expect(result.kind).toBe("json-api");
    expect(result.pagination?.type).toBe("page");
    expect(result.jsonSelectors?.title).toBe("$.title");
  });

  it("accepts a json-api source without jsonSelectors (default chain, #174)", () => {
    // `jsonSelectors` is optional now — the adapter resolves every field via
    // its default fallback chain (`$.title || $.name || $.headline`, etc.).
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      jsonSelectors: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jsonSelectors).toBeUndefined();
    }
  });

  it("accepts a json-api source where jsonSelectors omits title/link individually (#174)", () => {
    // Each field of jsonSelectors is independently optional — recipes can
    // declare just `items` (e.g. for a non-default envelope shape) and let
    // title/link fall through to the default chain.
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      jsonSelectors: { items: "$.results[*]" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jsonSelectors?.items).toBe("$.results[*]");
      expect(result.data.jsonSelectors?.title).toBeUndefined();
    }
  });

  it("requires `pagination` when kind is json-api", () => {
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      pagination: undefined,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "pagination");
      expect(issue).toBeDefined();
    }
  });

  it("applies default for pagination.maxPages when omitted", () => {
    const result = SourceSchema.parse({
      ...baseJsonApi,
      pagination: { type: "none" },
    });
    expect(result.pagination?.maxPages).toBe(20);
  });

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: `${VAR}` is
  // an intentional literal placeholder per ADR-0012 §D5c — recipe YAML stores
  // the placeholder text and the adapter does the interpolation at runtime.
  it("accepts http.headers with ${VAR} placeholders", () => {
    const result = SourceSchema.parse({
      ...baseJsonApi,
      http: {
        method: "GET",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
      },
    });
    expect(result.http?.headers.Authorization).toBe("Bearer ${GITHUB_TOKEN}");
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: see preceding comment

  it("rejects http.method other than GET (Phase 1 limit)", () => {
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      http: { method: "POST" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts all 6 pagination types", () => {
    for (const type of ["page", "offset", "cursor", "link-header", "token", "none"] as const) {
      const result = SourceSchema.safeParse({
        ...baseJsonApi,
        pagination: { type, maxPages: 5 },
      });
      expect(result.success, `pagination.type=${type} should parse`).toBe(true);
    }
  });

  it("rejects unknown pagination.type values", () => {
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      pagination: { type: "unknown" },
    });
    expect(result.success).toBe(false);
  });
});

describe("schemas/source - SourceJsOptionsSchema (ADR-0010)", () => {
  it("applies defaults for waitUntil and timeout", () => {
    const result = SourceJsOptionsSchema.parse({});
    expect(result.waitUntil).toBe("networkidle");
    expect(result.timeout).toBe(30000);
    // `waitFor` has no default at schema level — the adapter falls back to
    // `selectors.item` so the schema does not commit to a value here.
    expect(result.waitFor).toBeUndefined();
    expect(result.userAgent).toBeUndefined();
  });

  it("rejects invalid waitUntil values", () => {
    const result = SourceJsOptionsSchema.safeParse({ waitUntil: "lol" });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive timeout values", () => {
    expect(SourceJsOptionsSchema.safeParse({ timeout: 0 }).success).toBe(false);
    expect(SourceJsOptionsSchema.safeParse({ timeout: -1 }).success).toBe(false);
    // Non-integer timeouts are also rejected (the schema is `.int()`).
    expect(SourceJsOptionsSchema.safeParse({ timeout: 1.5 }).success).toBe(false);
  });
});
