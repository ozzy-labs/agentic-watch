import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { addSource, listSources, removeSource, runSource } from "../../src/cli/source.js";

interface Captured {
  log: string[];
  error: string[];
}

function captureIo(): {
  io: { log: (m: string) => void; error: (m: string) => void };
  captured: Captured;
} {
  const captured: Captured = { log: [], error: [] };
  return {
    io: {
      log: (m) => captured.log.push(m),
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
    workdir = await mkdtemp(join(tmpdir(), "agentic-watch-source-"));
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
      expect(parsed).toEqual({
        id: "anthropic-news",
        kind: "rss",
        url: "https://anthropic.com/news/rss.xml",
        name: "Anthropic News",
        tags: ["ai", "llm"],
        filters: {
          keywords: ["Claude", "agents"],
          excludeKeywords: ["deprecated"],
        },
      });
      expect(captured.log.some((m) => m.includes("created sources/anthropic-news.yaml"))).toBe(
        true,
      );
    });

    it("creates a minimal source with only required flags", async () => {
      const { io } = captureIo();
      const code = await addSource(["example", "--kind", "html", "--url", "https://example.com"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(0);
      const parsed = parseYaml(await readFile(join(workdir, "sources", "example.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        id: "example",
        kind: "html",
        url: "https://example.com",
        tags: [],
      });
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
      await addSource(["beta", "--kind", "html", "--url", "https://beta.example"], {
        cwd: workdir,
        io: captureIo().io,
      });

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
