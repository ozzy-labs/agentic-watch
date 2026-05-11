import { describe, expect, it } from "vitest";
import { evaluateFilter, filterItems } from "../../src/core/filter.js";
import type { Item, Source, SourceFilters } from "../../src/schemas/index.js";

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "i1",
    sourceId: "s1",
    title: "Claude Code releases new agents feature",
    url: "https://example.com/post-1",
    fetchedAt: "2026-05-12T00:00:00.000Z",
    summary: "Anthropic announced new Claude Code agents capabilities.",
    matchedKeywords: [],
    status: "detected",
    ...overrides,
  };
}

function makeFilters(overrides: Partial<SourceFilters> = {}): SourceFilters {
  return {
    keywords: [],
    excludeKeywords: [],
    matchMode: "word",
    matchFields: ["title", "summary"],
    caseSensitive: false,
    ...overrides,
  };
}

function makeSource(filters: Partial<SourceFilters> = {}): Source {
  return {
    id: "s1",
    kind: "rss",
    url: "https://example.com/feed.xml",
    tags: [],
    filters: makeFilters(filters),
  };
}

describe("core/filter — ADR-0006 evaluation order", () => {
  it("rejects when keywords is empty (no-match)", () => {
    expect(evaluateFilter(makeItem(), makeFilters({ keywords: [] }))).toBeNull();
  });

  it("accepts when any keyword hits", () => {
    const out = evaluateFilter(makeItem(), makeFilters({ keywords: ["agents"] }));
    expect(out).not.toBeNull();
    expect(out?.matchedKeywords).toEqual(["agents"]);
  });

  it("records multiple matched keywords", () => {
    const out = evaluateFilter(
      makeItem(),
      makeFilters({ keywords: ["Claude", "agents", "missing"] }),
    );
    expect(out?.matchedKeywords).toEqual(["Claude", "agents"]);
  });

  it("rejects when keyword does not appear", () => {
    expect(evaluateFilter(makeItem(), makeFilters({ keywords: ["completely-absent"] }))).toBeNull();
  });

  it("excludes when excludeKeywords hits, even if include also hits", () => {
    const out = evaluateFilter(
      makeItem(),
      makeFilters({ keywords: ["Claude"], excludeKeywords: ["agents"] }),
    );
    // Both hit but exclude wins per ADR-0006 step 3.
    expect(out).toBeNull();
  });

  it("excludes regardless of include list emptiness", () => {
    const out = evaluateFilter(
      makeItem(),
      makeFilters({ keywords: [], excludeKeywords: ["Claude"] }),
    );
    expect(out).toBeNull();
  });
});

describe("core/filter — matchMode", () => {
  it("word: matches on word boundaries only", () => {
    const item = makeItem({ title: "rustfmt and clippy", summary: "" });
    expect(evaluateFilter(item, makeFilters({ keywords: ["rust"] }))).toBeNull(); // partial
    expect(
      evaluateFilter(
        makeItem({ title: "rust is great", summary: "" }),
        makeFilters({ keywords: ["rust"] }),
      ),
    ).not.toBeNull();
  });

  it("substring: matches partials", () => {
    const out = evaluateFilter(
      makeItem({ title: "rustfmt notes", summary: "" }),
      makeFilters({ keywords: ["rust"], matchMode: "substring" }),
    );
    expect(out).not.toBeNull();
  });

  it("regex: matches user-supplied patterns", () => {
    const out = evaluateFilter(
      makeItem({ title: "Release v1.2.3", summary: "" }),
      makeFilters({ keywords: ["v\\d+\\.\\d+\\.\\d+"], matchMode: "regex" }),
    );
    expect(out).not.toBeNull();
  });

  it("regex: invalid pattern throws (ReDoS responsibility on caller)", () => {
    expect(() =>
      evaluateFilter(makeItem(), makeFilters({ keywords: ["[invalid"], matchMode: "regex" })),
    ).toThrow();
  });

  it("word: special regex chars in keyword are escaped (no compile error)", () => {
    // Word mode auto-escapes the keyword so regex metachars are taken
    // literally. Key behavior: compilation never crashes on user input.
    expect(() =>
      evaluateFilter(
        makeItem({ title: "release v1.0 ships", summary: "" }),
        makeFilters({ keywords: ["v1.0"], matchMode: "word" }),
      ),
    ).not.toThrow();
    // `.` is escaped so only a literal dot matches.
    const literalDotMatches = evaluateFilter(
      makeItem({ title: "release v1.0 ships", summary: "" }),
      makeFilters({ keywords: ["v1.0"], matchMode: "word" }),
    );
    expect(literalDotMatches).not.toBeNull();
    const literalDotMisses = evaluateFilter(
      makeItem({ title: "release v100 ships", summary: "" }),
      makeFilters({ keywords: ["v1.0"], matchMode: "word" }),
    );
    expect(literalDotMisses).toBeNull();
  });
});

describe("core/filter — case sensitivity", () => {
  it("ignores case by default", () => {
    const out = evaluateFilter(
      makeItem({ title: "CLAUDE rocks", summary: "" }),
      makeFilters({ keywords: ["claude"] }),
    );
    expect(out).not.toBeNull();
  });

  it("respects case when caseSensitive=true", () => {
    expect(
      evaluateFilter(
        makeItem({ title: "CLAUDE rocks", summary: "" }),
        makeFilters({ keywords: ["claude"], caseSensitive: true }),
      ),
    ).toBeNull();
    expect(
      evaluateFilter(
        makeItem({ title: "CLAUDE rocks", summary: "" }),
        makeFilters({ keywords: ["CLAUDE"], caseSensitive: true }),
      ),
    ).not.toBeNull();
  });
});

describe("core/filter — matchFields scoping", () => {
  it("limits search to title when configured", () => {
    const item = makeItem({ title: "Plain title", summary: "agents are great" });
    expect(
      evaluateFilter(item, makeFilters({ keywords: ["agents"], matchFields: ["title"] })),
    ).toBeNull();
  });

  it("silently skips body / tags for RSS sources (adapter doesn't supply)", () => {
    const item = makeItem({ title: "Plain title", summary: "no match here" });
    expect(
      evaluateFilter(item, makeFilters({ keywords: ["something"], matchFields: ["body", "tags"] })),
    ).toBeNull();
  });

  it("does not merge tokens across fields via \\b", () => {
    // title ends with "Claude", summary starts with "Code" — the join uses '\n'
    // so "Claude Code" must NOT match in word mode.
    const item = makeItem({ title: "Claude", summary: "Code launches" });
    const out = evaluateFilter(
      item,
      makeFilters({
        keywords: ["Claude Code"],
        matchMode: "word",
        matchFields: ["title", "summary"],
      }),
    );
    expect(out).toBeNull();
  });
});

describe("core/filter — filterItems batch", () => {
  it("returns only matching items annotated with matchedKeywords", () => {
    // Provide explicit summaries that do not bleed keywords from one item to
    // another — the default makeItem summary mentions both keywords.
    const items = [
      makeItem({ id: "a", title: "Claude release", summary: "nothing else" }),
      makeItem({ id: "b", title: "Unrelated", summary: "still nothing" }),
      makeItem({ id: "c", title: "agents update", summary: "more nothing" }),
    ];
    const out = filterItems(items, makeSource({ keywords: ["Claude", "agents"] }));
    expect(out.map((i) => i.id)).toEqual(["a", "c"]);
    expect(out[0].matchedKeywords).toEqual(["Claude"]);
    expect(out[1].matchedKeywords).toEqual(["agents"]);
  });
});
