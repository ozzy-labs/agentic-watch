import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runWatch } from "../../src/cli/watch.js";
import type { FetchLike } from "../../src/core/feeds/types.js";

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

function captureIo(): {
  io: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
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

function fetchReturning(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): FetchLike {
  return async () => ({
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
}

async function writeSource(
  workdir: string,
  id: string,
  filters: Record<string, unknown> = { keywords: ["agents"] },
): Promise<void> {
  await writeFile(
    join(workdir, "sources", `${id}.yaml`),
    stringifyYaml({
      id,
      kind: "rss",
      url: `https://example.com/${id}.xml`,
      tags: [],
      filters,
    }),
    "utf8",
  );
}

describe("cli/watch run", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "agentic-watch-watch-"));
    await mkdir(join(workdir, "sources"), { recursive: true });
    await mkdir(join(workdir, "state"), { recursive: true });
    await mkdir(join(workdir, "items"), { recursive: true });
  });

  it("emits items matching the source filter and updates state", async () => {
    await writeSource(workdir, "blog");
    const { io, captured } = captureIo();
    const code = await runWatch([], {
      cwd: workdir,
      io,
      fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
    });
    expect(code).toBe(0);

    const itemDir = join(workdir, "items", "blog");
    const itemFiles = await readdir(itemDir);
    expect(itemFiles).toHaveLength(1); // only the "agents" match
    expect(itemFiles[0]).toMatch(/^claude-code-releases-agents-[0-9a-f]{8}\.yaml$/);
    const itemBody = parseYaml(await readFile(join(itemDir, itemFiles[0]!), "utf8"));
    expect(itemBody).toMatchObject({
      sourceId: "blog",
      status: "detected",
      matchedKeywords: ["agents"],
    });
    expect(itemBody.id).toMatch(/^claude-code-releases-agents-[0-9a-f]{8}$/);

    const state = parseYaml(await readFile(join(workdir, "state", "blog.yaml"), "utf8"));
    expect(state.lastEtag).toBe('"v1"');
    expect(state.lastSeenIds).toHaveLength(2);
    expect(
      state.lastSeenIds.some((id: string) => /^claude-code-releases-agents-[0-9a-f]{8}$/.test(id)),
    ).toBe(true);
    expect(state.lastSeenIds.some((id: string) => /^unrelated-post-[0-9a-f]{8}$/.test(id))).toBe(
      true,
    );
    expect(state.lastFetchedAt).toBeTypeOf("string");

    expect(captured.log.some((m) => m.includes("1 new item(s)"))).toBe(true);
  });

  it("does not re-emit previously seen ids on subsequent runs", async () => {
    await writeSource(workdir, "blog");
    const first = await runWatch([], {
      cwd: workdir,
      io: captureIo().io,
      fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
    });
    expect(first).toBe(0);

    // Second run with the same RSS body — none of the items should be new.
    const { io, captured } = captureIo();
    const second = await runWatch([], {
      cwd: workdir,
      io,
      fetch: fetchReturning(RSS, 200, { ETag: '"v2"' }) as never,
    });
    expect(second).toBe(0);
    expect(captured.log.some((m) => m.includes("0 new"))).toBe(true);

    // Still only one item on disk (no duplicates).
    const files = await readdir(join(workdir, "items", "blog"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^claude-code-releases-agents-[0-9a-f]{8}\.yaml$/);
  });

  it("bootstrap seeds lastSeenIds without creating item files", async () => {
    await writeSource(workdir, "blog");
    const { io, captured } = captureIo();
    const code = await runWatch(["--bootstrap"], {
      cwd: workdir,
      io,
      fetch: fetchReturning(RSS) as never,
    });
    expect(code).toBe(0);

    // No items written.
    let itemFiles: string[];
    try {
      itemFiles = await readdir(join(workdir, "items", "blog"));
    } catch {
      itemFiles = [];
    }
    expect(itemFiles).toEqual([]);

    const state = parseYaml(await readFile(join(workdir, "state", "blog.yaml"), "utf8"));
    expect(state.lastSeenIds).toHaveLength(2);
    expect(
      state.lastSeenIds.some((id: string) => /^claude-code-releases-agents-[0-9a-f]{8}$/.test(id)),
    ).toBe(true);
    expect(state.lastSeenIds.some((id: string) => /^unrelated-post-[0-9a-f]{8}$/.test(id))).toBe(
      true,
    );
    expect(captured.log.some((m) => m.includes("bootstrap"))).toBe(true);
  });

  it("respects --source to limit which sources run", async () => {
    await writeSource(workdir, "blog");
    await writeSource(workdir, "other");
    const { io } = captureIo();
    let fetchCount = 0;
    const fetchImpl: FetchLike = async () => {
      fetchCount++;
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => RSS,
      };
    };
    const code = await runWatch(["--source", "blog"], {
      cwd: workdir,
      io,
      fetch: fetchImpl as never,
    });
    expect(code).toBe(0);
    expect(fetchCount).toBe(1);
  });

  it("warns on 304 and does not produce new items", async () => {
    await writeSource(workdir, "blog");
    // Seed state with an etag so the adapter sends If-None-Match
    await writeFile(
      join(workdir, "state", "blog.yaml"),
      stringifyYaml({ sourceId: "blog", lastEtag: '"prev"', lastSeenIds: [] }),
      "utf8",
    );
    const { io, captured } = captureIo();
    const code = await runWatch([], {
      cwd: workdir,
      io,
      fetch: fetchReturning("", 304, { ETag: '"prev"' }) as never,
    });
    expect(code).toBe(0);
    expect(captured.log.some((m) => m.toLowerCase().includes("unchanged"))).toBe(true);
  });

  it("returns non-zero when a source fetch fails but continues with others", async () => {
    await writeSource(workdir, "good");
    await writeSource(workdir, "bad");
    let callCount = 0;
    const fetchImpl: FetchLike = async (url) => {
      callCount++;
      if (String(url).includes("bad")) {
        return {
          status: 500,
          headers: { get: () => null },
          text: async () => "err",
        };
      }
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => RSS,
      };
    };
    const { io, captured } = captureIo();
    const code = await runWatch([], {
      cwd: workdir,
      io,
      fetch: fetchImpl as never,
    });
    expect(code).toBe(1);
    expect(callCount).toBe(2);
    expect(captured.error.some((m) => m.includes("bad"))).toBe(true);
  });

  it("rejects unknown options", async () => {
    const { io, captured } = captureIo();
    const code = await runWatch(["--nope"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("unknown option"))).toBe(true);
  });

  it("prints help with --help", async () => {
    const { io, captured } = captureIo();
    const code = await runWatch(["--help"], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(captured.log.some((m) => m.includes("Usage:"))).toBe(true);
  });
});
