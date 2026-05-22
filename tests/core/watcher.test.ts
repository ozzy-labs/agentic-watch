import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../src/core/feeds/types.js";
import type { ProgressReporter } from "../../src/core/progress.js";
import { shouldEnableProgress, watchRun } from "../../src/core/watcher.js";
import type { Source } from "../../src/schemas/index.js";

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

function makeSourceLite(kind: Source["kind"], id = "x"): Source {
  // Minimal `Source` shaped enough to feed `shouldEnableProgress`. We
  // intentionally do NOT round-trip through `SourceSchema.parse` here
  // because the heuristic only reads `kind`, and the other fields would
  // pull in fixture sprawl unrelated to the assertion under test.
  return {
    id,
    kind,
    url: "https://example.com",
    tags: [],
    filters: {
      keywords: [],
      excludeKeywords: [],
      matchMode: "word",
      matchFields: ["title", "summary"],
      caseSensitive: false,
    },
    trustLevel: "untrusted",
  } as Source;
}

describe("shouldEnableProgress (heuristic, #198)", () => {
  it("returns false for 1-2 fast-kind sources (typical small workspace)", () => {
    expect(shouldEnableProgress([makeSourceLite("rss")], false)).toBe(false);
    expect(shouldEnableProgress([makeSourceLite("rss"), makeSourceLite("html", "b")], false)).toBe(
      false,
    );
  });

  it("returns true once 3 or more sources are queued", () => {
    expect(
      shouldEnableProgress(
        [makeSourceLite("rss", "a"), makeSourceLite("rss", "b"), makeSourceLite("rss", "c")],
        false,
      ),
    ).toBe(true);
  });

  it("returns true for any html-js source regardless of count", () => {
    expect(shouldEnableProgress([makeSourceLite("html-js")], false)).toBe(true);
    expect(
      shouldEnableProgress([makeSourceLite("rss", "a"), makeSourceLite("html-js", "b")], false),
    ).toBe(true);
  });

  it("returns true for json-api in --backfill mode but not in normal mode", () => {
    expect(shouldEnableProgress([makeSourceLite("json-api")], true)).toBe(true);
    // Normal mode: a single json-api fetch is fast (1 page) so the
    // heuristic stays off until the 3-source threshold trips.
    expect(shouldEnableProgress([makeSourceLite("json-api")], false)).toBe(false);
  });
});

describe("watchRun progress integration (#198)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "feedradar-watcher-progress-"));
    await mkdir(join(workdir, "sources"), { recursive: true });
    await mkdir(join(workdir, "state"), { recursive: true });
    await mkdir(join(workdir, "items"), { recursive: true });
  });

  function recordingReporter() {
    const events: Array<{ kind: string; arg1?: string; arg2?: string | number }> = [];
    const reporter: ProgressReporter = {
      phase: (name, info) => {
        events.push({ kind: "phase", arg1: name, arg2: info });
      },
      start: (label) => {
        events.push({ kind: "start", arg1: label });
      },
      update: (metrics) => {
        events.push({ kind: "update", arg1: JSON.stringify(metrics) });
      },
      succeed: (label, duration) => {
        events.push({ kind: "succeed", arg1: label, arg2: duration });
      },
      fail: (label, reason) => {
        events.push({ kind: "fail", arg1: label, arg2: reason });
      },
      raw: () => {},
    };
    return { reporter, events };
  }

  async function writeJsonApiSource(id: string): Promise<void> {
    await writeFile(
      join(workdir, "sources", `${id}.yaml`),
      [
        `id: ${id}`,
        "kind: json-api",
        "url: https://example.com/api",
        "tags: []",
        "filters:",
        "  keywords:",
        "    - release",
        "pagination:",
        "  type: page",
        "  param: page",
        "  start: 0",
        "  pageSize: 2",
        "  maxPages: 5",
        "jsonSelectors:",
        "  items: $.items[*]",
        "  title: $.title",
        "  link: $.url",
        "  publisherId: $.id",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  function mockPagedFetch(pages: Array<{ items: number; idStart: number }>): FetchLike {
    const queue = pages.map(({ items, idStart }) =>
      JSON.stringify({
        items: Array.from({ length: items }, (_, i) => ({
          id: `r-${idStart + i}`,
          title: `release ${idStart + i}`,
          url: `https://example.com/r/${idStart + i}`,
        })),
      }),
    );
    let i = 0;
    return async () => {
      const body = queue[i++] ?? JSON.stringify({ items: [] });
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => body,
      };
    };
  }

  it("emits per-page phase markers during --backfill on a json-api source", async () => {
    await writeJsonApiSource("aws");
    const io = silentIo();
    const { reporter, events } = recordingReporter();
    await watchRun({
      cwd: workdir,
      backfill: true,
      maxPagesOverride: 3,
      fetch: mockPagedFetch([
        { items: 2, idStart: 1 },
        { items: 2, idStart: 3 },
        { items: 1, idStart: 5 },
      ]) as never,
      log: io.log,
      warn: io.warn,
      error: io.error,
      progress: reporter,
    });
    const phaseNames = events.filter((e) => e.kind === "phase").map((e) => e.arg1 ?? "");
    // Per-source start marker.
    expect(phaseNames).toContain("[aws] Fetching…");
    // One Page X/Y marker per fetched page (3 pages here).
    const pageMarkers = phaseNames.filter((n) => n.startsWith("[aws] Page "));
    expect(pageMarkers).toEqual([
      "[aws] Page 1/3: 2 items fetched",
      "[aws] Page 2/3: 2 items fetched",
      "[aws] Page 3/3: 1 items fetched",
    ]);
    // Per-source completion goes through succeed() so the spinner row
    // stops cleanly.
    const succeed = events.find((e) => e.kind === "succeed");
    expect(succeed?.arg1).toContain("[aws] Completed:");
    expect(succeed?.arg1).toContain("5 total");
    expect(succeed?.arg1).toContain("5 new");
  });

  it("no-ops when the heuristic is off (single rss source, no backfill)", async () => {
    // Single rss source ≠ html-js/json-api ≠ 3+ sources: the heuristic
    // gate must drop the reporter so the typical small workspace stays
    // clean even when the CLI happened to construct a reporter.
    await writeSource(workdir, "blog");
    const io = silentIo();
    const { reporter, events } = recordingReporter();
    await watchRun({
      cwd: workdir,
      fetch: fetchReturning(RSS, 200, { ETag: '"v1"' }) as never,
      log: io.log,
      warn: io.warn,
      error: io.error,
      progress: reporter,
    });
    // Zero events — the watcher never invoked the reporter because the
    // run was too small to narrate.
    expect(events).toEqual([]);
  });

  it("RADAR_NO_PROGRESS=1 produces a no-op reporter whose stream stays empty", async () => {
    // End-to-end proof of the ADR-0015 D2 env escape hatch: feed the
    // CLI's own `createProgressReporter()` factory into the watcher
    // with the env flag set, and assert the writable stream receives
    // zero bytes even though the heuristic-eligible json-api source
    // would otherwise narrate per page.
    const { createProgressReporter } = await import("../../src/core/progress.js");
    await writeJsonApiSource("aws");
    const io = silentIo();
    const chunks: string[] = [];
    const stream = {
      write(data: string | Uint8Array): boolean {
        chunks.push(typeof data === "string" ? data : Buffer.from(data).toString());
        return true;
      },
    } as NodeJS.WritableStream;
    const prev = process.env.RADAR_NO_PROGRESS;
    process.env.RADAR_NO_PROGRESS = "1";
    try {
      const reporter = createProgressReporter({ level: "normal", tty: true, stream });
      await watchRun({
        cwd: workdir,
        backfill: true,
        maxPagesOverride: 1,
        fetch: mockPagedFetch([{ items: 1, idStart: 0 }]) as never,
        log: io.log,
        warn: io.warn,
        error: io.error,
        progress: reporter,
      });
      // No bytes written to the reporter stream — the no-op reporter
      // discarded everything despite the heuristic being on.
      expect(chunks.join("")).toBe("");
    } finally {
      if (prev === undefined) {
        delete process.env.RADAR_NO_PROGRESS;
      } else {
        process.env.RADAR_NO_PROGRESS = prev;
      }
    }
  });

  it("preserves the legacy 1-line log even when progress is enabled (#198 ac#7)", async () => {
    // Acceptance criterion 7: existing 1-line logs must remain so users
    // who scripted around them are not broken. We pin this by enabling
    // the reporter AND asserting the legacy line still appears.
    await writeJsonApiSource("aws");
    const logs: string[] = [];
    const { reporter } = recordingReporter();
    await watchRun({
      cwd: workdir,
      backfill: true,
      maxPagesOverride: 1,
      fetch: mockPagedFetch([{ items: 1, idStart: 0 }]) as never,
      log: (m) => logs.push(m),
      warn: () => {},
      error: () => {},
      progress: reporter,
    });
    // Legacy 1-line per source summary.
    expect(logs.some((m) => m.includes("'aws' fetched 1 items"))).toBe(true);
  });
});
