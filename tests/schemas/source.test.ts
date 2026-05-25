import { describe, expect, it } from "vitest";
import {
  SourceJsOptionsSchema,
  SourceSchema,
  SourceTriagePolicySchema,
} from "../../src/schemas/source.js";

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

describe("schemas/source - maxSeenIds (#333)", () => {
  it("leaves maxSeenIds undefined when omitted (unbounded, current behavior)", () => {
    const result = SourceSchema.parse({
      id: "aws",
      kind: "rss",
      url: "https://example.com/feed.xml",
    });
    expect(result.maxSeenIds).toBeUndefined();
  });

  it("accepts a positive integer maxSeenIds", () => {
    const result = SourceSchema.parse({
      id: "aws",
      kind: "rss",
      url: "https://example.com/feed.xml",
      maxSeenIds: 500,
    });
    expect(result.maxSeenIds).toBe(500);
  });

  it("rejects a zero / negative / non-integer maxSeenIds", () => {
    for (const bad of [0, -1, 1.5]) {
      const result = SourceSchema.safeParse({
        id: "aws",
        kind: "rss",
        url: "https://example.com/feed.xml",
        maxSeenIds: bad,
      });
      expect(result.success).toBe(false);
    }
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

  it("accepts a fully-qualified http(s) URL for jsonSelectors.linkBase (#204)", () => {
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      jsonSelectors: {
        ...baseJsonApi.jsonSelectors,
        linkBase: "https://aws.amazon.com",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jsonSelectors?.linkBase).toBe("https://aws.amazon.com");
    }
  });

  it("rejects a non-URL value for jsonSelectors.linkBase (#204)", () => {
    // The schema fails fast on a malformed base because silently mis-resolving
    // every per-item link would be worse than a parse error.
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      jsonSelectors: {
        ...baseJsonApi.jsonSelectors,
        linkBase: "not a url",
      },
    });
    expect(result.success).toBe(false);
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

describe("schemas/source - facets (ADR-0017)", () => {
  const baseJsonApi = {
    id: "aws-whats-new",
    kind: "json-api" as const,
    url: "https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new-v2",
    pagination: {
      type: "page" as const,
      param: "page",
      start: 0,
      pageSize: 100,
      pageSizeParam: "size",
      maxPages: 30,
    },
  };

  it("accepts a json-api source without facets (backward compat)", () => {
    // Existing recipes (PR #229 / #232) omit `facets` entirely. They must
    // continue to parse with the new optional field unset.
    const result = SourceSchema.parse(baseJsonApi);
    expect(result.facets).toBeUndefined();
  });

  it("accepts a valid range facet", () => {
    const result = SourceSchema.parse({
      ...baseJsonApi,
      facets: {
        year: {
          type: "range",
          range: [2004, 2026],
          step: 1,
          param: "tags.id",
          template: "whats-new-v2#year#{}",
        },
      },
    });
    expect(result.facets?.year?.type).toBe("range");
  });

  it("accepts a range facet with a `current-year` sentinel upper bound (#257)", () => {
    // The end element may be the literal "current-year" instead of a number;
    // the adapter resolves it to the current calendar year at fetch time so
    // year-axis recipes do not silently drop new items at year boundaries.
    const result = SourceSchema.parse({
      ...baseJsonApi,
      facets: {
        year: {
          type: "range",
          range: [2004, "current-year"],
          step: 1,
          param: "tags.id",
          template: "whats-new-v2#year#{}",
        },
      },
    });
    expect(result.facets?.year?.type).toBe("range");
    const year = result.facets?.year;
    if (year?.type === "range") {
      expect(year.range[1]).toBe("current-year");
    }
  });

  it("rejects a range facet with an unknown sentinel upper bound", () => {
    // Only the exact "current-year" sentinel is accepted; arbitrary strings
    // (e.g. typos like "current_year") must fail-fast at parse time rather
    // than silently being treated as 0 items.
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      facets: {
        year: {
          type: "range",
          range: [2004, "current_year"],
          step: 1,
          param: "tags.id",
          template: "whats-new-v2#year#{}",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid enum facet", () => {
    const result = SourceSchema.parse({
      ...baseJsonApi,
      facets: {
        category: {
          type: "enum",
          values: ["compute", "storage", "database"],
          param: "category",
          template: "{}",
        },
      },
    });
    expect(result.facets?.category?.type).toBe("enum");
  });

  it("rejects a facet template missing the {} placeholder", () => {
    // The Zod refine catches malformed templates so `.replace("{}", ...)`
    // does not silently no-op at runtime (which would inject a fixed
    // string and ignore the facet value entirely).
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      facets: {
        year: {
          type: "range",
          range: [2004, 2026],
          step: 1,
          param: "tags.id",
          template: "whats-new-v2#year#2024", // missing {}
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a range facet with step <= 0", () => {
    // step: 0 would yield an infinite loop in the adapter; step: -1 would
    // walk backwards past the start. Schema rejects both.
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      facets: {
        year: {
          type: "range",
          range: [2004, 2026],
          step: 0,
          param: "tags.id",
          template: "whats-new-v2#year#{}",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a range facet where start > end", () => {
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      facets: {
        year: {
          type: "range",
          range: [2026, 2004], // inverted
          step: 1,
          param: "tags.id",
          template: "whats-new-v2#year#{}",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an enum facet with empty values", () => {
    const result = SourceSchema.safeParse({
      ...baseJsonApi,
      facets: {
        category: {
          type: "enum",
          values: [], // empty
          param: "category",
          template: "{}",
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("schemas/source - SourceTriagePolicySchema (ADR-0018 §W3)", () => {
  const MIN_POLICY = {
    agent: "gemini-cli" as const,
    rules: "AWS service GA → research. リージョン拡張 → dismiss.",
  };

  it("parses a minimal policy and defaults confidenceThreshold to 0.7", () => {
    // 0.7 is the ADR-0018-recommended cheap-model threshold; the default
    // belongs to the schema so unspecified policies do not silently degrade
    // to "every decision sticks regardless of confidence" (= threshold 0).
    const result = SourceTriagePolicySchema.parse(MIN_POLICY);
    expect(result.agent).toBe("gemini-cli");
    expect(result.confidenceThreshold).toBe(0.7);
    expect(result.rules).toContain("research");
  });

  it("accepts every AgentIdSchema value", () => {
    for (const agent of ["claude-code", "codex-cli", "gemini-cli", "copilot"] as const) {
      const result = SourceTriagePolicySchema.safeParse({ ...MIN_POLICY, agent });
      expect(result.success, `agent=${agent} should parse`).toBe(true);
    }
  });

  it("accepts explicit confidenceThreshold in [0, 1]", () => {
    const low = SourceTriagePolicySchema.parse({ ...MIN_POLICY, confidenceThreshold: 0 });
    expect(low.confidenceThreshold).toBe(0);
    const high = SourceTriagePolicySchema.parse({ ...MIN_POLICY, confidenceThreshold: 1 });
    expect(high.confidenceThreshold).toBe(1);
  });

  it("rejects confidenceThreshold outside [0, 1]", () => {
    expect(
      SourceTriagePolicySchema.safeParse({ ...MIN_POLICY, confidenceThreshold: -0.1 }).success,
    ).toBe(false);
    expect(
      SourceTriagePolicySchema.safeParse({ ...MIN_POLICY, confidenceThreshold: 1.1 }).success,
    ).toBe(false);
  });

  it("rejects empty rules (= no signal for the triage agent)", () => {
    // An empty policy would let the agent free-associate, defeating the
    // whole per-source SSoT decision (ADR-0018 §W3). Better to fail fast at
    // schema parse than ship a no-op policy to production.
    const result = SourceTriagePolicySchema.safeParse({ ...MIN_POLICY, rules: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown agent value", () => {
    const result = SourceTriagePolicySchema.safeParse({ ...MIN_POLICY, agent: "ollama" });
    expect(result.success).toBe(false);
  });
});

describe("schemas/source - triagePolicy field on SourceSchema (ADR-0018)", () => {
  it("makes triagePolicy optional (existing source YAMLs validate unchanged)", () => {
    // Sources written before ADR-0018 omit `triagePolicy:` entirely. The
    // schema must accept that shape so the new field is truly additive.
    const result = SourceSchema.parse({
      id: "anthropic-news",
      kind: "rss",
      url: "https://anthropic.com/news/rss.xml",
    });
    expect(result.triagePolicy).toBeUndefined();
  });

  it("accepts a SourceSchema with an explicit triagePolicy", () => {
    const result = SourceSchema.parse({
      id: "aws-whats-new",
      kind: "rss",
      url: "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
      triagePolicy: {
        agent: "gemini-cli",
        confidenceThreshold: 0.8,
        rules: "新サービス GA は research。リージョン拡張は dismiss。",
      },
    });
    expect(result.triagePolicy?.agent).toBe("gemini-cli");
    expect(result.triagePolicy?.confidenceThreshold).toBe(0.8);
  });

  it("rejects a SourceSchema with a malformed triagePolicy (= surfaces config error early)", () => {
    const result = SourceSchema.safeParse({
      id: "aws-whats-new",
      kind: "rss",
      url: "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
      triagePolicy: {
        agent: "gemini-cli",
        rules: "", // empty
      },
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
