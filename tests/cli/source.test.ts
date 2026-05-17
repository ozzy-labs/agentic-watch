import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { addSource, listSources, removeSource, runSource } from "../../src/cli/source.js";

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
      const parsed = parseYaml(
        await readFile(join(workdir, "sources", "example-js.yaml"), "utf8"),
      );
      expect(parsed).toMatchObject({
        id: "example-js",
        kind: "html-js",
        url: "https://example.com/changelog",
        selectors: { item: ".item", title: "h3", link: "a" },
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

  describe("dispatcher", () => {
    it("routes to add/list/remove subcommands", async () => {
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
