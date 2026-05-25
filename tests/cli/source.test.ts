import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  addSource,
  listSources,
  recipesSubcommand,
  removeSource,
  runSource,
  testSource,
} from "../../src/cli/source.js";
import type { FetchLike } from "../../src/core/feeds/types.js";

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

function captureIo(): {
  io: {
    log: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
  captured: Captured;
} {
  const captured: Captured = { log: [], warn: [], error: [] };
  return {
    io: {
      log: (m) => captured.log.push(m),
      warn: (m) => captured.warn.push(m),
      error: (m) => captured.error.push(m),
    },
    captured,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("cli/source", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-source-"));
    await mkdir(join(workdir, "sources"), { recursive: true });
    await mkdir(join(workdir, "state"), { recursive: true });
    await mkdir(join(workdir, "items"), { recursive: true });
  });

  describe("add", () => {
    it("creates a sources/<id>.yaml file with normalized payload", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(
        [
          "anthropic-news",
          "--kind",
          "rss",
          "--url",
          "https://anthropic.com/news/rss.xml",
          "--name",
          "Anthropic News",
          "--tags",
          "ai,llm",
          "--keywords",
          "Claude,agents",
          "--exclude-keywords",
          "deprecated",
        ],
        { cwd: workdir, io },
      );

      expect(code).toBe(0);
      const file = join(workdir, "sources", "anthropic-news.yaml");
      expect(await pathExists(file)).toBe(true);
      const body = await readFile(file, "utf8");
      const parsed = parseYaml(body);
      // Schema now applies ADR-0006 defaults (matchMode / matchFields /
      // caseSensitive) when the user does not provide them; the YAML on disk
      // therefore includes the normalized full filter block.
      expect(parsed).toEqual({
        id: "anthropic-news",
        kind: "rss",
        url: "https://anthropic.com/news/rss.xml",
        name: "Anthropic News",
        tags: ["ai", "llm"],
        filters: {
          keywords: ["Claude", "agents"],
          excludeKeywords: ["deprecated"],
          matchMode: "word",
          matchFields: ["title", "summary"],
          requireFields: [],
          caseSensitive: false,
        },
        // ADR-0009 M4: schema defaults all sources to `"untrusted"` so existing
        // YAML on disk (and freshly generated ones like this test asserts)
        // includes the field after the schema lands.
        trustLevel: "untrusted",
      });
      expect(captured.log.some((m) => m.includes("created sources/anthropic-news.yaml"))).toBe(
        true,
      );
    });

    it("creates a minimal source with only required flags", async () => {
      const { io } = captureIo();
      const code = await addSource(["example", "--kind", "rss", "--url", "https://example.com"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "example.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        id: "example",
        kind: "rss",
        url: "https://example.com",
        tags: [],
      });
    });

    it("creates an html source with selectors", async () => {
      const { io } = captureIo();
      const code = await addSource(
        [
          "example",
          "--kind",
          "html",
          "--url",
          "https://example.com",
          "--selector-item",
          "article.entry",
          "--selector-title",
          "h2",
          "--selector-link",
          "a.permalink",
          "--selector-summary",
          "p.summary",
        ],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "example.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        id: "example",
        kind: "html",
        url: "https://example.com",
        selectors: {
          item: "article.entry",
          title: "h2",
          link: "a.permalink",
          summary: "p.summary",
        },
      });
    });

    it("creates an html-js source with selectors", async () => {
      const { io } = captureIo();
      const code = await addSource(
        [
          "example-js",
          "--kind",
          "html-js",
          "--url",
          "https://example.com/changelog",
          "--selector-item",
          ".item",
          "--selector-title",
          "h3",
          "--selector-link",
          "a",
        ],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "example-js.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        id: "example-js",
        kind: "html-js",
        url: "https://example.com/changelog",
        selectors: { item: ".item", title: "h3", link: "a" },
      });
    });

    it("creates a json-api source with default pagination strategy (#174)", async () => {
      // No --pagination-* flags → adapter defaults to `type: page` per
      // the most common shape (dev.to / AWS What's New). `jsonSelectors`
      // is intentionally omitted from the generated YAML — the default
      // fallback chain covers simple APIs, and recipe authors edit the
      // YAML directly when explicit selectors are required.
      const { io, captured } = captureIo();
      const code = await addSource(
        [
          "devto",
          "--kind",
          "json-api",
          "--url",
          "https://dev.to/api/articles?per_page=10",
          "--keywords",
          "rust",
        ],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "devto.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        id: "devto",
        kind: "json-api",
        url: "https://dev.to/api/articles?per_page=10",
        pagination: { type: "page", maxPages: 20 },
      });
      // No jsonSelectors block is generated — relies on default chain.
      expect((parsed as { jsonSelectors?: unknown }).jsonSelectors).toBeUndefined();
      expect(captured.log.some((m) => m.includes("created sources/devto.yaml"))).toBe(true);
    });

    it("creates a json-api source with explicit pagination flags (#174)", async () => {
      const { io } = captureIo();
      const code = await addSource(
        [
          "aws",
          "--kind",
          "json-api",
          "--url",
          "https://aws.amazon.com/api/dirs/items/search",
          "--keywords",
          "lambda",
          "--pagination-strategy",
          "page",
          "--pagination-param",
          "page",
          "--pagination-start",
          "0",
          "--page-size",
          "100",
          "--page-size-param",
          "size",
          "--max-pages",
          "200",
          "--total-path",
          "$.totalHits",
        ],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "aws.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        id: "aws",
        kind: "json-api",
        pagination: {
          type: "page",
          param: "page",
          start: 0,
          pageSize: 100,
          pageSizeParam: "size",
          maxPages: 200,
          totalPath: "$.totalHits",
        },
      });
    });

    it("creates a json-api source with cursor pagination (#174)", async () => {
      const { io } = captureIo();
      const code = await addSource(
        [
          "anthropic",
          "--kind",
          "json-api",
          "--url",
          "https://www.anthropic.com/api/news",
          "--keywords",
          "Claude",
          "--pagination-strategy",
          "cursor",
          "--pagination-param",
          "after",
          "--next-cursor-path",
          "$.pageInfo.endCursor",
        ],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "anthropic.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        pagination: {
          type: "cursor",
          param: "after",
          nextCursorPath: "$.pageInfo.endCursor",
        },
      });
    });

    it("rejects an invalid --pagination-strategy value (#174)", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(
        [
          "bad",
          "--kind",
          "json-api",
          "--url",
          "https://x.example/api",
          "--pagination-strategy",
          "graphql",
        ],
        { cwd: workdir, io },
      );
      expect(code).toBe(2);
      expect(
        captured.error.some((m) => m.includes("--pagination-strategy") && m.includes("graphql")),
      ).toBe(true);
      // The enum list should appear in the error so users can self-correct.
      expect(captured.error.some((m) => m.includes("link-header"))).toBe(true);
    });

    it("rejects a non-integer --page-size value (#174)", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(
        ["bad", "--kind", "json-api", "--url", "https://x.example/api", "--page-size", "abc"],
        { cwd: workdir, io },
      );
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--page-size"))).toBe(true);
    });

    it("rejects --page-size 0 (must be positive) (#174)", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(
        ["bad", "--kind", "json-api", "--url", "https://x.example/api", "--page-size", "0"],
        { cwd: workdir, io },
      );
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--page-size"))).toBe(true);
    });

    it("rejects negative --max-pages (#174)", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(
        ["bad", "--kind", "json-api", "--url", "https://x.example/api", "--max-pages", "-1"],
        { cwd: workdir, io },
      );
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--max-pages"))).toBe(true);
    });

    it("accepts --pagination-start 0 (legal initial offset) (#174)", async () => {
      const { io } = captureIo();
      const code = await addSource(
        [
          "off",
          "--kind",
          "json-api",
          "--url",
          "https://x.example/api",
          "--pagination-strategy",
          "offset",
          "--pagination-start",
          "0",
          "--page-size",
          "50",
        ],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "off.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        pagination: { type: "offset", start: 0, pageSize: 50 },
      });
    });

    it("rejects --pagination-* on a non-json-api kind (#174)", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(
        ["bad", "--kind", "rss", "--url", "https://x.example/feed.xml", "--page-size", "10"],
        { cwd: workdir, io },
      );
      expect(code).toBe(2);
      expect(
        captured.error.some(
          (m) => m.includes("--pagination-*") && m.includes("only valid with --kind json-api"),
        ),
      ).toBe(true);
    });

    it("combines json-api with existing --keywords / --tags flags (#174)", async () => {
      const { io } = captureIo();
      const code = await addSource(
        [
          "combo",
          "--kind",
          "json-api",
          "--url",
          "https://x.example/api",
          "--keywords",
          "rust,wasm",
          "--exclude-keywords",
          "draft",
          "--tags",
          "blog,news",
          "--name",
          "Combo Feed",
          "--page-size",
          "20",
        ],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "combo.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        name: "Combo Feed",
        tags: ["blog", "news"],
        filters: {
          keywords: ["rust", "wasm"],
          excludeKeywords: ["draft"],
        },
        pagination: { type: "page", pageSize: 20 },
      });
    });

    it("rejects an html-js source without selectors", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(
        ["bad-js", "--kind", "html-js", "--url", "https://example.com"],
        { cwd: workdir, io },
      );
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("selectors"))).toBe(true);
      expect(await pathExists(join(workdir, "sources", "bad-js.yaml"))).toBe(false);
    });

    it("error message for unknown --kind includes html-js as a valid option", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(["bad", "--kind", "atom", "--url", "https://example.com"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("html-js"))).toBe(true);
    });

    it("rejects an html source without selectors", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(["bad", "--kind", "html", "--url", "https://example.com"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("selectors"))).toBe(true);
      expect(await pathExists(join(workdir, "sources", "bad.yaml"))).toBe(false);
    });

    it("rejects an unknown --kind value", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(["bad", "--kind", "atom", "--url", "https://example.com"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(await pathExists(join(workdir, "sources", "bad.yaml"))).toBe(false);
      expect(captured.error.some((m) => m.includes("invalid --kind"))).toBe(true);
    });

    it("rejects a non-URL --url value", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(["bad", "--kind", "rss", "--url", "not-a-url"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("validation failed"))).toBe(true);
      expect(await pathExists(join(workdir, "sources", "bad.yaml"))).toBe(false);
    });

    it("accepts a bare package name for --kind npm-registry", async () => {
      // npm-registry relaxes the URL validation (see ADR-0002 / #38) so the
      // user-guide-documented bare-package form succeeds. The adapter will
      // canonicalize `@anthropic-ai/sdk` into the registry URL at fetch time.
      const { io, captured } = captureIo();
      const code = await addSource(
        ["sdk", "--kind", "npm-registry", "--url", "@anthropic-ai/sdk"],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "sdk.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        id: "sdk",
        kind: "npm-registry",
        url: "@anthropic-ai/sdk",
      });
      expect(captured.log.some((m) => m.includes("created sources/sdk.yaml"))).toBe(true);
    });

    it("accepts the public npmjs.com URL form for --kind npm-registry", async () => {
      const { io } = captureIo();
      const code = await addSource(
        ["react", "--kind", "npm-registry", "--url", "https://www.npmjs.com/package/react"],
        { cwd: workdir, io },
      );
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "react.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        kind: "npm-registry",
        url: "https://www.npmjs.com/package/react",
      });
    });

    it("errors when --url is missing", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(["bad", "--kind", "rss"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--url is required"))).toBe(true);
    });

    it("errors when --kind is missing", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(["bad", "--url", "https://example.com"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--kind is required"))).toBe(true);
    });

    it("errors when <id> is missing", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(["--kind", "rss", "--url", "https://example.com"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("missing <id>"))).toBe(true);
    });

    it.each([
      ["../escape"],
      ["foo/bar"],
      [".hidden"],
      ["with space"],
    ])("rejects an unsafe id %j", async (id) => {
      const { io, captured } = captureIo();
      const code = await addSource([id, "--kind", "rss", "--url", "https://example.com"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("invalid <id>"))).toBe(true);
      // No file written, including no traversal escapes.
      expect(await pathExists(join(workdir, "sources", `${id}.yaml`))).toBe(false);
    });

    it("refuses to overwrite an existing source (no --force)", async () => {
      const { io: io1 } = captureIo();
      await addSource(["dup", "--kind", "rss", "--url", "https://example.com/a"], {
        cwd: workdir,
        io: io1,
      });

      const { io: io2, captured } = captureIo();
      const code = await addSource(["dup", "--kind", "rss", "--url", "https://example.com/b"], {
        cwd: workdir,
        io: io2,
      });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("already exists"))).toBe(true);
      // Existing file is not clobbered.
      const parsed = parseYaml(await readFile(join(workdir, "sources", "dup.yaml"), "utf8"));
      expect(parsed).toMatchObject({ url: "https://example.com/a" });
    });

    describe("keywords warning", () => {
      it("warns when --keywords is not provided (would filter out everything)", async () => {
        const { io, captured } = captureIo();
        const code = await addSource(
          ["nokw", "--kind", "rss", "--url", "https://example.com/feed.xml"],
          { cwd: workdir, io },
        );
        // Add still succeeds — the warn is non-fatal so scripts that pipe the
        // success message keep working.
        expect(code).toBe(0);
        expect(captured.log.some((m) => m.includes("created sources/nokw.yaml"))).toBe(true);
        expect(captured.warn.some((m) => m.includes("no keywords"))).toBe(true);
        expect(captured.warn.some((m) => m.includes("nokw"))).toBe(true);
        // The hint should point the user at the actionable next step.
        expect(
          captured.warn.some(
            (m) => m.includes("Edit sources/nokw.yaml") || m.includes("--keywords"),
          ),
        ).toBe(true);
      });

      it("does not warn when --keywords is provided", async () => {
        const { io, captured } = captureIo();
        const code = await addSource(
          [
            "withkw",
            "--kind",
            "rss",
            "--url",
            "https://example.com/feed.xml",
            "--keywords",
            "Claude",
          ],
          { cwd: workdir, io },
        );
        expect(code).toBe(0);
        expect(captured.warn).toEqual([]);
      });

      it("warns when --keywords is passed but empty (e.g. trailing comma)", async () => {
        // splitCsv strips empties, so `--keywords ","` collapses to []. That
        // still trips the firehose guard at filter time, so we must warn here
        // as well to keep the UX consistent with the "no flag" case.
        const { io, captured } = captureIo();
        const code = await addSource(
          ["emptykw", "--kind", "rss", "--url", "https://example.com/feed.xml", "--keywords", ","],
          { cwd: workdir, io },
        );
        expect(code).toBe(0);
        expect(captured.warn.some((m) => m.includes("no keywords"))).toBe(true);
      });
    });
  });

  describe("list", () => {
    it("prints guidance when no sources exist", async () => {
      const { io, captured } = captureIo();
      const code = await listSources([], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("no sources defined"))).toBe(true);
    });

    it("prints a table of added sources", async () => {
      await addSource(
        ["alpha", "--kind", "rss", "--url", "https://alpha.example/feed.xml", "--tags", "a,b"],
        { cwd: workdir, io: captureIo().io },
      );
      await addSource(
        [
          "beta",
          "--kind",
          "html",
          "--url",
          "https://beta.example",
          "--selector-item",
          "article",
          "--selector-title",
          "h1",
          "--selector-link",
          "a",
        ],
        { cwd: workdir, io: captureIo().io },
      );

      const { io, captured } = captureIo();
      const code = await listSources([], { cwd: workdir, io });
      expect(code).toBe(0);
      const out = captured.log.join("\n");
      expect(out).toMatch(/ID\s+KIND\s+URL\s+TAGS/);
      expect(out).toContain("alpha");
      expect(out).toContain("beta");
      expect(out).toContain("a,b");
      expect(out).toContain("https://alpha.example/feed.xml");
    });

    it("reports malformed YAML files without crashing", async () => {
      await writeFile(join(workdir, "sources", "bad.yaml"), "::: not yaml :::", "utf8");
      const { io, captured } = captureIo();
      const code = await listSources([], { cwd: workdir, io });
      // Only malformed entry -> non-zero exit
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("bad.yaml"))).toBe(true);
    });

    describe("--verbose", () => {
      it("prints keywords, trustLevel and lastFetchedAt when -v is set", async () => {
        await addSource(
          [
            "alpha",
            "--kind",
            "rss",
            "--url",
            "https://alpha.example/feed.xml",
            "--tags",
            "a,b",
            "--keywords",
            "Claude,agents",
          ],
          { cwd: workdir, io: captureIo().io },
        );
        // Seed a state file so we can assert lastFetchedAt rendering against a
        // real ISO timestamp rather than the "never" fallback.
        await writeFile(
          join(workdir, "state", "alpha.yaml"),
          "sourceId: alpha\nlastFetchedAt: 2026-05-17T09:00:00.000Z\nlastSeenIds: []\n",
          "utf8",
        );

        const { io, captured } = captureIo();
        const code = await listSources(["-v"], { cwd: workdir, io });
        expect(code).toBe(0);
        const out = captured.log.join("\n");
        // Verbose output should NOT use the table header used by default mode.
        expect(out).not.toMatch(/^ID\s+KIND\s+URL\s+TAGS$/m);
        // Detail fields the table cannot show.
        expect(out).toContain("keywords:");
        expect(out).toContain("Claude,agents");
        expect(out).toContain("trustLevel:");
        expect(out).toContain("untrusted");
        expect(out).toContain("lastFetchedAt:");
        expect(out).toContain("2026-05-17T09:00:00.000Z");
      });

      it("renders lastFetchedAt as 'never' when no state file exists yet", async () => {
        await addSource(
          [
            "fresh",
            "--kind",
            "rss",
            "--url",
            "https://fresh.example/feed.xml",
            "--keywords",
            "Claude",
          ],
          { cwd: workdir, io: captureIo().io },
        );
        const { io, captured } = captureIo();
        const code = await listSources(["--verbose"], { cwd: workdir, io });
        expect(code).toBe(0);
        const out = captured.log.join("\n");
        expect(out).toMatch(/lastFetchedAt:\s+never/);
      });

      it("flags sources with no keywords in the verbose keywords line", async () => {
        // Use the warning sink so the add-time warn does not leak into the
        // verbose-list assertion below.
        await addSource(["empty", "--kind", "rss", "--url", "https://empty.example/feed.xml"], {
          cwd: workdir,
          io: captureIo().io,
        });
        const { io, captured } = captureIo();
        const code = await listSources(["-v"], { cwd: workdir, io });
        expect(code).toBe(0);
        const out = captured.log.join("\n");
        expect(out).toMatch(/keywords:\s+\(none/);
      });

      it("default list output is unchanged (table mode without --verbose)", async () => {
        await addSource(
          ["alpha", "--kind", "rss", "--url", "https://alpha.example/feed.xml", "--keywords", "k"],
          { cwd: workdir, io: captureIo().io },
        );
        const { io, captured } = captureIo();
        const code = await listSources([], { cwd: workdir, io });
        expect(code).toBe(0);
        const out = captured.log.join("\n");
        // The table contract is preserved for non-verbose callers.
        expect(out).toMatch(/ID\s+KIND\s+URL\s+TAGS/);
        // And the verbose-only fields are absent.
        expect(out).not.toContain("trustLevel:");
        expect(out).not.toContain("lastFetchedAt:");
      });
    });
  });

  describe("remove", () => {
    it("deletes sources/<id>.yaml but preserves state/ and items/", async () => {
      await addSource(["alpha", "--kind", "rss", "--url", "https://alpha.example/feed.xml"], {
        cwd: workdir,
        io: captureIo().io,
      });
      // Simulate previously-recorded state and items.
      await writeFile(join(workdir, "state", "alpha.yaml"), "lastFetchedAt: 2026-01-01\n", "utf8");
      await mkdir(join(workdir, "items", "alpha"), { recursive: true });
      await writeFile(join(workdir, "items", "alpha", "x.yaml"), "id: x\n", "utf8");

      const { io, captured } = captureIo();
      const code = await removeSource(["alpha"], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("deleted sources/alpha.yaml"))).toBe(true);
      expect(await pathExists(join(workdir, "sources", "alpha.yaml"))).toBe(false);
      // State + items must remain (history protection).
      expect(await pathExists(join(workdir, "state", "alpha.yaml"))).toBe(true);
      expect(await pathExists(join(workdir, "items", "alpha", "x.yaml"))).toBe(true);
    });

    it("errors when the source does not exist", async () => {
      const { io, captured } = captureIo();
      const code = await removeSource(["ghost"], { cwd: workdir, io });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("not found"))).toBe(true);
    });

    it("errors when <id> is missing", async () => {
      const { io, captured } = captureIo();
      const code = await removeSource([], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("missing <id>"))).toBe(true);
    });

    it("rejects an unsafe id (path traversal)", async () => {
      const { io, captured } = captureIo();
      const code = await removeSource(["../etc/passwd"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("invalid <id>"))).toBe(true);
    });
  });

  describe("test", () => {
    const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test</title>
    <link>https://example.com</link>
    <description>x</description>
    <item>
      <title>Claude Code releases agents</title>
      <link>https://example.com/a</link>
      <description>Anthropic announced new agents features.</description>
      <guid isPermaLink="false">a</guid>
      <pubDate>Mon, 12 May 2026 09:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Unrelated post</title>
      <link>https://example.com/b</link>
      <description>Nothing to see here.</description>
      <guid isPermaLink="false">b</guid>
      <pubDate>Mon, 12 May 2026 10:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>
`;

    function fetchReturning(body: string, status = 200, headers: Record<string, string> = {}) {
      const impl: FetchLike = async () => ({
        status,
        headers: {
          get(name: string): string | null {
            const lower = name.toLowerCase();
            for (const [k, v] of Object.entries(headers)) {
              if (k.toLowerCase() === lower) return v;
            }
            return null;
          },
        },
        text: async () => body,
      });
      return impl;
    }

    it("prints matched output to stdout (happy path)", async () => {
      // Register a source with a single matching keyword. `source add` lays
      // down the canonical YAML so we exercise the same code path users hit.
      await addSource(
        ["blog", "--kind", "rss", "--url", "https://example.com/blog.xml", "--keywords", "agents"],
        { cwd: workdir, io: captureIo().io },
      );

      const { io, captured } = captureIo();
      const code = await testSource(["blog"], {
        cwd: workdir,
        io,
        fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
      });
      expect(code).toBe(0);
      const out = captured.log.join("\n");
      // Summary line reports the canonical fetched/filtered/matched breakdown.
      expect(out).toMatch(/fetched:\s*2/);
      expect(out).toMatch(/filtered:\s*1/);
      expect(out).toMatch(/matched:\s*1/);
      // Matched item title + URL + matchedKeywords should appear in stdout.
      expect(out).toContain("Claude Code releases agents");
      expect(out).toContain("https://example.com/a");
      expect(out).toContain("agents");
    });

    it("does not create state/<id>.yaml or items/<id>/ entries (dry-run)", async () => {
      await addSource(
        ["blog", "--kind", "rss", "--url", "https://example.com/blog.xml", "--keywords", "agents"],
        { cwd: workdir, io: captureIo().io },
      );

      const { io } = captureIo();
      const code = await testSource(["blog"], {
        cwd: workdir,
        io,
        fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
      });
      expect(code).toBe(0);

      // No state file was written for this source.
      expect(await pathExists(join(workdir, "state", "blog.yaml"))).toBe(false);
      // The items directory for this source either does not exist or is empty
      // — either way, no item YAML must have been persisted.
      const itemDir = join(workdir, "items", "blog");
      if (await pathExists(itemDir)) {
        const files = await readdir(itemDir);
        expect(files).toEqual([]);
      }
    });

    it("respects --limit when more matches exist", async () => {
      const MULTI_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Multi</title>
    <link>https://example.com</link>
    <description>x</description>
    <item><title>agents post one</title><link>https://example.com/1</link><guid isPermaLink="false">1</guid></item>
    <item><title>agents post two</title><link>https://example.com/2</link><guid isPermaLink="false">2</guid></item>
    <item><title>agents post three</title><link>https://example.com/3</link><guid isPermaLink="false">3</guid></item>
  </channel>
</rss>
`;
      await addSource(
        [
          "multi",
          "--kind",
          "rss",
          "--url",
          "https://example.com/multi.xml",
          "--keywords",
          "agents",
        ],
        { cwd: workdir, io: captureIo().io },
      );

      const { io, captured } = captureIo();
      const code = await testSource(["multi", "--limit", "2"], {
        cwd: workdir,
        io,
        fetch: fetchReturning(MULTI_RSS) as never,
      });
      expect(code).toBe(0);
      const out = captured.log.join("\n");
      expect(out).toMatch(/matched:\s*3/);
      // Only the first two items are listed.
      expect(out).toContain("agents post one");
      expect(out).toContain("agents post two");
      expect(out).not.toContain("agents post three");
      // The trailing "N more" hint surfaces the truncation.
      expect(out).toMatch(/1 more/);
    });

    it("includes body content when --show-content is set", async () => {
      await addSource(
        ["blog", "--kind", "rss", "--url", "https://example.com/blog.xml", "--keywords", "agents"],
        { cwd: workdir, io: captureIo().io },
      );

      const { io, captured } = captureIo();
      const code = await testSource(["blog", "--show-content"], {
        cwd: workdir,
        io,
        fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
      });
      expect(code).toBe(0);
      const out = captured.log.join("\n");
      // RSS description should surface as the content preview.
      expect(out).toContain("Anthropic announced new agents features");
    });

    it("renders selector adoption + pagination preview for json-api (#174)", async () => {
      // Use a json-api source with no explicit `jsonSelectors.title` so the
      // adapter falls through the default chain and adopts `$.headline`.
      // The pagination preview should report `nextUrl` for page 1 without
      // actually requesting it (dry-run page-0-only contract).
      await addSource(
        [
          "headlines",
          "--kind",
          "json-api",
          "--url",
          "https://example.com/api/headlines",
          "--keywords",
          "rust",
          "--page-size",
          "2",
        ],
        { cwd: workdir, io: captureIo().io },
      );
      const body = JSON.stringify({
        items: [
          {
            headline: "Rust 2.0 released",
            url: "https://example.com/r2",
            description: "Rust 2 lands.",
          },
        ],
      });
      const { io, captured } = captureIo();
      const code = await testSource(["headlines", "--show-content"], {
        cwd: workdir,
        io,
        fetch: fetchReturning(body, 200, {}) as never,
      });
      expect(code).toBe(0);
      const out = captured.log.join("\n");
      expect(out).toContain("selector adoption:");
      // Default locale is English now (#342 A4): the selector-adoption block
      // renders "<field> ← adopted <path>" rather than the old mixed-language
      // "<field> ← <path> を採用".
      expect(out).toMatch(/title ← adopted \$\.headline/);
      expect(out).toMatch(/link ← adopted \$\.url/);
      expect(out).toContain("pagination preview");
      expect(out).toContain("strategy:  page");
      expect(out).toMatch(/nextUrl:\s+https/);
    });

    it("does not fetch page 1 for json-api source test (#174)", async () => {
      // Even though the recipe declares maxPages=20, dry-run must only
      // fetch page 0. We assert this by ensuring our fetch stub is called
      // exactly once.
      await addSource(
        [
          "single-page",
          "--kind",
          "json-api",
          "--url",
          "https://example.com/api/items",
          "--keywords",
          "anything",
          "--page-size",
          "1",
        ],
        { cwd: workdir, io: captureIo().io },
      );
      const body = JSON.stringify({
        items: [{ title: "anything goes", url: "https://example.com/x" }],
      });
      let callCount = 0;
      const fetchImpl: FetchLike = async () => {
        callCount++;
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => body,
        };
      };
      const { io } = captureIo();
      const code = await testSource(["single-page"], {
        cwd: workdir,
        io,
        fetch: fetchImpl,
      });
      expect(code).toBe(0);
      expect(callCount).toBe(1);
    });

    it("warns which single facet value was tested for a facet-sweep source (#256)", async () => {
      // Facet sweep sources are recipe-only, so write the YAML directly. A
      // dry-run `source test` probes the range UPPER bound (latest year)
      // and must warn the user that only that one slice was walked.
      const facetYaml = [
        "id: aws-facet",
        "kind: json-api",
        "url: https://example.com/api/items?size=10",
        "tags: []",
        "filters:",
        "  keywords: []",
        "  excludeKeywords: []",
        "  matchMode: word",
        "  matchFields: [title, summary]",
        "  caseSensitive: false",
        "trustLevel: untrusted",
        "pagination:",
        "  type: page",
        "  param: page",
        "  start: 0",
        "  pageSize: 10",
        "  pageSizeParam: size",
        "  maxPages: 5",
        "facets:",
        "  year:",
        "    type: range",
        "    param: tags.id",
        "    template: y-{}",
        "    range: [2024, 2026]",
        "    step: 1",
        "",
      ].join("\n");
      await writeFile(join(workdir, "sources", "aws-facet.yaml"), facetYaml, "utf8");

      const calls: string[] = [];
      const fetchImpl: FetchLike = async (url) => {
        calls.push(typeof url === "string" ? url : url.toString());
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ items: [{ title: "x", url: "https://e/x" }] }),
        };
      };
      const { io, captured } = captureIo();
      const code = await testSource(["aws-facet"], { cwd: workdir, io, fetch: fetchImpl });
      expect(code).toBe(0);
      // Only the latest year (2026) was fetched (one slice, page 0 only).
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("y-2026");
      // The warning names the facet, the tested value, and the total count.
      const warning = captured.warn.join("\n");
      expect(warning).toContain("facet sweep");
      expect(warning).toContain("year=2026");
      expect(warning).toContain("3");
    });

    it("exits 1 for an unknown source id (no YAML on disk)", async () => {
      const { io, captured } = captureIo();
      const code = await testSource(["ghost"], { cwd: workdir, io });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("not found"))).toBe(true);
      expect(captured.error.some((m) => m.includes("ghost"))).toBe(true);
    });

    it("exits 2 when <id> is missing", async () => {
      const { io, captured } = captureIo();
      const code = await testSource([], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("missing <id>"))).toBe(true);
    });

    it("exits 2 on an unsafe id (path traversal)", async () => {
      const { io, captured } = captureIo();
      const code = await testSource(["../escape"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("invalid <id>"))).toBe(true);
    });

    it("exits 2 on a bad --limit value", async () => {
      const { io, captured } = captureIo();
      const code = await testSource(["blog", "--limit", "abc"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("--limit"))).toBe(true);
    });

    it("prints help with --help", async () => {
      const { io, captured } = captureIo();
      const code = await testSource(["--help"], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("Usage:"))).toBe(true);
      expect(captured.log.some((m) => m.includes("--limit"))).toBe(true);
      expect(captured.log.some((m) => m.includes("--show-content"))).toBe(true);
    });

    describe("--verbose / --quiet (#198)", () => {
      it("rejects --verbose + --quiet as mutually exclusive", async () => {
        const { io, captured } = captureIo();
        const code = await testSource(["blog", "--verbose", "--quiet"], { cwd: workdir, io });
        expect(code).toBe(2);
        expect(captured.error.some((m) => m.includes("mutually exclusive"))).toBe(true);
      });

      it("accepts --quiet and runs to completion (legacy summary still emitted)", async () => {
        await addSource(
          [
            "blog",
            "--kind",
            "rss",
            "--url",
            "https://example.com/blog.xml",
            "--keywords",
            "agents",
          ],
          { cwd: workdir, io: captureIo().io },
        );
        const { io, captured } = captureIo();
        const code = await testSource(["blog", "--quiet"], {
          cwd: workdir,
          io,
          fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
        });
        expect(code).toBe(0);
        // --quiet suppresses progress reporter but not the dry-run
        // summary block from the CLI itself.
        expect(captured.log.some((m) => m.match(/fetched:\s*2/))).toBe(true);
      });

      it("documents --verbose / --quiet in --help", async () => {
        const { io, captured } = captureIo();
        const code = await testSource(["--help"], { cwd: workdir, io });
        expect(code).toBe(0);
        const help = captured.log.join("\n");
        expect(help).toContain("--verbose");
        expect(help).toContain("--quiet");
        expect(help).toContain("RADAR_NO_PROGRESS");
      });

      it("emits progress narration for kind=json-api during source test (#198)", async () => {
        // json-api is one of the slow kinds the heuristic narrates even
        // for a single source. We assert narration ends up on stderr
        // (the progress reporter writes there by default) via
        // RADAR_NO_PROGRESS=0 + capturing process.stderr. Using the
        // captureIo() sinks would not exercise the reporter, so instead
        // we just smoke-test that the command exits 0 and the legacy
        // log line is present — the deeper assertion lives in
        // tests/core/watcher.test.ts where we inject a recording
        // reporter directly.
        await addSource(
          [
            "headlines",
            "--kind",
            "json-api",
            "--url",
            "https://example.com/api/headlines",
            "--keywords",
            "rust",
            "--page-size",
            "2",
          ],
          { cwd: workdir, io: captureIo().io },
        );
        const body = JSON.stringify({
          items: [
            { id: "1", title: "Rust 2.0 ships", url: "https://example.com/r2" },
            { id: "2", title: "Rust unrelated", url: "https://example.com/r3" },
          ],
        });
        const { io, captured } = captureIo();
        const code = await testSource(["headlines"], {
          cwd: workdir,
          io,
          fetch: fetchReturning(body) as never,
        });
        expect(code).toBe(0);
        // Heuristic narration is asserted directly in the watcher test;
        // here we only confirm the source test path runs the json-api
        // adapter without errors and emits the summary line.
        expect(captured.log.some((m) => m.includes("source test: headlines"))).toBe(true);
      });
    });
  });

  describe("full cycle", () => {
    it("supports add -> list -> remove without state leakage", async () => {
      const ioBox = captureIo();
      expect(
        await addSource(
          ["cycle", "--kind", "rss", "--url", "https://cycle.example/feed.xml", "--tags", "x"],
          { cwd: workdir, io: ioBox.io },
        ),
      ).toBe(0);

      const listBox = captureIo();
      expect(await listSources([], { cwd: workdir, io: listBox.io })).toBe(0);
      expect(listBox.captured.log.some((m) => m.includes("cycle"))).toBe(true);

      const removeBox = captureIo();
      expect(await removeSource(["cycle"], { cwd: workdir, io: removeBox.io })).toBe(0);

      const list2Box = captureIo();
      expect(await listSources([], { cwd: workdir, io: list2Box.io })).toBe(0);
      expect(list2Box.captured.log.some((m) => m.includes("no sources defined"))).toBe(true);
    });
  });

  describe("recipes (#181)", () => {
    let recipesDir: string;
    beforeEach(async () => {
      // Each test gets its own recipes/ tmpdir so writes in one case do
      // not leak into another. We inject the path through SourceCommandOptions
      // rather than monkey-patching the resolver.
      recipesDir = await mkdtemp(join(tmpdir(), "feedradar-cli-recipes-"));
    });

    it("`recipes` prints a friendly empty message when no recipes are bundled", async () => {
      const { io, captured } = captureIo();
      const code = await recipesSubcommand([], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("no recipes bundled"))).toBe(true);
    });

    it("`recipes` lists valid bundled recipes with name / kind / description", async () => {
      await writeFile(
        join(recipesDir, "aws-whats-new.yaml"),
        `kind: json-api
url: https://aws.amazon.com/api/dirs/items/search
description: AWS What's New feed (full-history backfill)
pagination:
  type: page
  pageSize: 100
  maxPages: 200
`,
        "utf8",
      );
      await writeFile(
        join(recipesDir, "devto.yaml"),
        `kind: json-api
url: https://dev.to/api/articles
description: dev.to articles
pagination:
  type: page
  pageSize: 30
  maxPages: 20
`,
        "utf8",
      );

      const { io, captured } = captureIo();
      const code = await recipesSubcommand([], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(0);
      // Header + 2 entries + apply-hint footer.
      expect(captured.log.some((m) => m.includes("NAME") && m.includes("KIND"))).toBe(true);
      expect(captured.log.some((m) => m.includes("aws-whats-new"))).toBe(true);
      expect(captured.log.some((m) => m.includes("devto"))).toBe(true);
      // Description text is surfaced verbatim.
      expect(captured.log.some((m) => m.includes("AWS What's New feed"))).toBe(true);
      // Sorted: aws-whats-new comes before devto.
      const awsLine = captured.log.findIndex((m) => m.includes("aws-whats-new"));
      const devtoLine = captured.log.findIndex((m) => m.includes("devto"));
      expect(awsLine).toBeLessThan(devtoLine);
    });

    it("`recipes` separates malformed recipes from the valid set", async () => {
      await writeFile(
        join(recipesDir, "good.yaml"),
        "kind: rss\nurl: https://good.example.com/feed.xml\n",
        "utf8",
      );
      // Invalid: missing `url`.
      await writeFile(join(recipesDir, "bad.yaml"), "kind: rss\n", "utf8");

      const { io, captured } = captureIo();
      const code = await recipesSubcommand([], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("good"))).toBe(true);
      expect(captured.log.some((m) => m.includes("Recipes with errors:"))).toBe(true);
      expect(
        captured.log.some((m) => m.includes("bad") && m.includes("schema validation failed")),
      ).toBe(true);
    });

    it("`recipes --help` prints usage", async () => {
      const { io, captured } = captureIo();
      const code = await recipesSubcommand(["--help"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("Usage:"))).toBe(true);
    });

    it("`recipes` rejects unknown options", async () => {
      const { io, captured } = captureIo();
      const code = await recipesSubcommand(["--nope"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("unknown option"))).toBe(true);
    });

    it("`add --recipe <name>` writes sources/<id>.yaml from a bundled recipe", async () => {
      await writeFile(
        join(recipesDir, "devto.yaml"),
        `kind: json-api
url: https://dev.to/api/articles
description: dev.to articles
name: Dev.to
tags:
  - blog
filters:
  keywords:
    - rust
pagination:
  type: page
  pageSize: 30
  maxPages: 20
`,
        "utf8",
      );

      const { io, captured } = captureIo();
      const code = await addSource(["devto-rust", "--recipe", "devto"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(0);
      const written = parseYaml(
        await readFile(join(workdir, "sources", "devto-rust.yaml"), "utf8"),
      );
      expect(written).toMatchObject({
        id: "devto-rust",
        kind: "json-api",
        url: "https://dev.to/api/articles",
        name: "Dev.to",
        tags: ["blog"],
        filters: { keywords: ["rust"] },
        pagination: { type: "page", pageSize: 30, maxPages: 20 },
      });
      // Recipe description must not leak into the generated source YAML.
      expect((written as { description?: unknown }).description).toBeUndefined();
      expect(
        captured.log.some(
          (m) => m.includes("created sources/devto-rust.yaml") && m.includes("from recipe"),
        ),
      ).toBe(true);
    });

    it("`add --recipe` honours --keywords / --tags / --name overrides", async () => {
      await writeFile(
        join(recipesDir, "devto.yaml"),
        `kind: json-api
url: https://dev.to/api/articles
filters:
  keywords:
    - default-kw
tags:
  - default-tag
pagination:
  type: page
`,
        "utf8",
      );

      const { io } = captureIo();
      const code = await addSource(
        [
          "custom",
          "--recipe",
          "devto",
          "--keywords",
          "Rust,tokio",
          "--exclude-keywords",
          "draft",
          "--tags",
          "rust,lang",
          "--name",
          "Custom Display",
        ],
        { cwd: workdir, io, recipesRoot: recipesDir },
      );
      expect(code).toBe(0);
      const written = parseYaml(await readFile(join(workdir, "sources", "custom.yaml"), "utf8"));
      expect(written).toMatchObject({
        name: "Custom Display",
        tags: ["rust", "lang"],
        filters: {
          keywords: ["Rust", "tokio"],
          excludeKeywords: ["draft"],
        },
      });
    });

    it("`add --recipe` fails with exit 1 when the recipe does not exist", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(["foo", "--recipe", "ghost"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("'ghost' not found"))).toBe(true);
    });

    it("`add --recipe` fails when the bundled recipe has invalid YAML", async () => {
      await writeFile(join(recipesDir, "broken.yaml"), "kind: rss\nurl: '", "utf8");
      const { io, captured } = captureIo();
      const code = await addSource(["foo", "--recipe", "broken"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("invalid YAML in recipe 'broken'"))).toBe(true);
    });

    it("`add --recipe` fails when the bundled recipe fails Zod validation", async () => {
      // `kind: bogus` is not in the enum.
      await writeFile(
        join(recipesDir, "bogus.yaml"),
        "kind: bogus\nurl: https://x.example/feed\n",
        "utf8",
      );
      const { io, captured } = captureIo();
      const code = await addSource(["foo", "--recipe", "bogus"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(1);
      expect(
        captured.error.some((m) => m.includes("recipe 'bogus' failed schema validation")),
      ).toBe(true);
    });

    it("`add --recipe` rejects --kind / --url passthrough flags", async () => {
      await writeFile(
        join(recipesDir, "rss.yaml"),
        "kind: rss\nurl: https://example.com/feed.xml\n",
        "utf8",
      );
      const { io, captured } = captureIo();
      const code = await addSource(
        ["x", "--recipe", "rss", "--kind", "html", "--url", "https://other.example/"],
        { cwd: workdir, io, recipesRoot: recipesDir },
      );
      expect(code).toBe(2);
      expect(
        captured.error.some(
          (m) =>
            m.includes("--kind") && m.includes("--url") && m.includes("not allowed with --recipe"),
        ),
      ).toBe(true);
    });

    it("`add --recipe` refuses to overwrite an existing sources/<id>.yaml", async () => {
      await writeFile(
        join(recipesDir, "rss.yaml"),
        "kind: rss\nurl: https://example.com/feed.xml\n",
        "utf8",
      );
      // Pre-populate the source file to trigger the no-overwrite guard.
      await writeFile(
        join(workdir, "sources", "dup.yaml"),
        "kind: rss\nurl: https://other.example/\n",
        "utf8",
      );
      const { io, captured } = captureIo();
      const code = await addSource(["dup", "--recipe", "rss"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("'dup' already exists"))).toBe(true);
    });

    it("`add --recipe` rejects unsafe recipe names", async () => {
      const { io, captured } = captureIo();
      const code = await addSource(["x", "--recipe", "../escape"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("invalid recipe name"))).toBe(true);
    });

    it("dispatcher routes `recipes` subcommand", async () => {
      const { io, captured } = captureIo();
      const code = await runSource(["recipes"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(0);
      expect(captured.log.some((m) => m.includes("no recipes bundled"))).toBe(true);
    });

    it("`add --recipe` warns when filters.keywords is empty after merge", async () => {
      // Recipe has no keywords and the user supplies none — the firehose
      // guard should fire.
      await writeFile(
        join(recipesDir, "empty-kw.yaml"),
        "kind: rss\nurl: https://example.com/feed.xml\n",
        "utf8",
      );
      const { io, captured } = captureIo();
      const code = await addSource(["bare", "--recipe", "empty-kw"], {
        cwd: workdir,
        io,
        recipesRoot: recipesDir,
      });
      expect(code).toBe(0);
      expect(
        captured.warn.some((m) => m.includes("has no keywords") && m.includes("filtered out")),
      ).toBe(true);
    });
  });

  describe("dispatcher", () => {
    it("routes to add/list/remove/test subcommands", async () => {
      const ioBox = captureIo();
      expect(
        await runSource(["add", "router", "--kind", "rss", "--url", "https://r.example/feed.xml"], {
          cwd: workdir,
          io: ioBox.io,
        }),
      ).toBe(0);

      const listBox = captureIo();
      expect(await runSource(["list"], { cwd: workdir, io: listBox.io })).toBe(0);
      expect(listBox.captured.log.some((m) => m.includes("router"))).toBe(true);

      // `test --help` is the cheapest way to prove the dispatcher hands off
      // to `testSource` without needing a working fetch stub here.
      const testBox = captureIo();
      expect(await runSource(["test", "--help"], { cwd: workdir, io: testBox.io })).toBe(0);
      expect(testBox.captured.log.some((m) => m.includes("source test"))).toBe(true);

      const removeBox = captureIo();
      expect(await runSource(["remove", "router"], { cwd: workdir, io: removeBox.io })).toBe(0);
    });

    it("errors on unknown subcommand", async () => {
      const { io, captured } = captureIo();
      const code = await runSource(["wat"], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("unknown subcommand"))).toBe(true);
    });

    it("prints help when no subcommand is given", async () => {
      const { io, captured } = captureIo();
      const code = await runSource([], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.log.some((m) => m.includes("Usage:"))).toBe(true);
    });
  });
});
