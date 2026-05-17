import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../src/core/feeds/types.js";
import { watchRun } from "../../src/core/watcher.js";

/**
 * Tests for the `dryRun` option on `watchRun` (#132 / parent epic #129).
 *
 * The CLI-level smoke tests live in `tests/cli/watch.test.ts`; this file
 * exercises the core API directly so the contract used by
 * `radar source test` (#133) is pinned down independently of the CLI
 * surface. The fixtures intentionally mirror `tests/cli/watch.test.ts` so
 * a behavioral regression in the inner pipeline shows up here even before
 * the CLI wrapper changes.
 */

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

async function writeSource(workdir: string, id: string): Promise<void> {
  const yaml = [
    `id: ${id}`,
    "kind: rss",
    `url: https://example.com/${id}.xml`,
    "tags: []",
    "filters:",
    "  keywords:",
    "    - agents",
    "",
  ].join("\n");
  await writeFile(join(workdir, "sources", `${id}.yaml`), yaml, "utf8");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function silentIo() {
  return {
    log: (_m: string) => {},
    warn: (_m: string) => {},
    error: (_m: string) => {},
  };
}

describe("watchRun dryRun option", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-watcher-dryrun-"));
    await mkdir(join(workdir, "sources"), { recursive: true });
    await mkdir(join(workdir, "state"), { recursive: true });
    await mkdir(join(workdir, "items"), { recursive: true });
  });

  it("dryRun: true does not write any item files under items/", async () => {
    await writeSource(workdir, "blog");
    const io = silentIo();
    const result = await watchRun({
      cwd: workdir,
      dryRun: true,
      fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
      log: io.log,
      warn: io.warn,
      error: io.error,
    });

    // The pipeline still ran (no errors) and projected the would-be state.
    expect(result.errors).toEqual([]);
    expect(result.states.blog).toBeDefined();

    // items/blog/ may not exist at all in dry-run; if it does it must be empty.
    const itemDir = join(workdir, "items", "blog");
    if (await pathExists(itemDir)) {
      const files = await readdir(itemDir);
      expect(files).toEqual([]);
    }
  });

  it("dryRun: true does not update the state YAML on disk", async () => {
    await writeSource(workdir, "blog");
    // Seed an existing state file so we can assert it was not overwritten.
    const seeded = ["sourceId: blog", 'lastEtag: "seeded"', "lastSeenIds: []", ""].join("\n");
    await writeFile(join(workdir, "state", "blog.yaml"), seeded, "utf8");

    const io = silentIo();
    const result = await watchRun({
      cwd: workdir,
      dryRun: true,
      fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
      log: io.log,
      warn: io.warn,
      error: io.error,
    });

    // In-memory projected state should reflect the new etag / ids…
    expect(result.states.blog?.lastEtag).toBe('"v1"');
    expect(result.states.blog?.lastSeenIds.length).toBeGreaterThan(0);

    // …but the file on disk must still be the seeded one.
    const onDisk = await readFile(join(workdir, "state", "blog.yaml"), "utf8");
    expect(onDisk).toBe(seeded);
  });

  it("dryRun: true creates no state YAML when none existed previously", async () => {
    await writeSource(workdir, "blog");
    const io = silentIo();
    await watchRun({
      cwd: workdir,
      dryRun: true,
      fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
      log: io.log,
      warn: io.warn,
      error: io.error,
    });

    // No state file should have been written.
    expect(await pathExists(join(workdir, "state", "blog.yaml"))).toBe(false);
  });

  it("dryRun: true still populates detected with matched items", async () => {
    await writeSource(workdir, "blog");
    const io = silentIo();
    const result = await watchRun({
      cwd: workdir,
      dryRun: true,
      fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
      log: io.log,
      warn: io.warn,
      error: io.error,
    });

    expect(result.detected.blog).toBeDefined();
    expect(result.detected.blog).toHaveLength(1);
    const [match] = result.detected.blog ?? [];
    if (!match) throw new Error("unreachable: detected.blog length checked above");
    expect(match.sourceId).toBe("blog");
    expect(match.title).toContain("agents");
    expect(match.matchedKeywords).toEqual(["agents"]);
  });

  it("dryRun: false (default) regression — still writes items and state", async () => {
    await writeSource(workdir, "blog");
    const io = silentIo();
    const result = await watchRun({
      cwd: workdir,
      // dryRun omitted on purpose — exercises the default-false path.
      fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
      log: io.log,
      warn: io.warn,
      error: io.error,
    });

    expect(result.errors).toEqual([]);
    expect(result.detected.blog).toHaveLength(1);

    // Items are persisted.
    const itemFiles = await readdir(join(workdir, "items", "blog"));
    expect(itemFiles).toHaveLength(1);

    // State YAML is persisted with the new etag.
    const state = await readFile(join(workdir, "state", "blog.yaml"), "utf8");
    expect(state).toContain("lastEtag: '\"v1\"'");
    expect(state).toContain("lastSeenIds:");
  });
});
