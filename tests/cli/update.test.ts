import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentAdapter, UpdateRequest } from "../../src/agents/index.js";
import { registerAgentAdapter } from "../../src/agents/index.js";
import { runUpdate } from "../../src/cli/update.js";
import type { Item, ItemStatus, ResearchFrontmatter } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

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

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const V1_ID = "20260510_anthropic-news-claude-code-shiny-new-feature_v1";
const BASE = "20260510_anthropic-news-claude-code-shiny-new-feature";
const V2_ID = `${BASE}_v2`;
const V3_ID = `${BASE}_v3`;
const V4_ID = `${BASE}_v4`;

const SAMPLE_ITEM: Item = ItemSchema.parse({
  id: "anthropic-news-2026-05-10-claude-code",
  sourceId: "anthropic-news",
  title: "Claude Code: shiny new feature",
  url: "https://anthropic.com/news/claude-code-shiny",
  publishedAt: "2026-05-10T00:00:00.000Z",
  fetchedAt: "2026-05-10T01:00:00.000Z",
  summary: "New feature in Claude Code.",
  matchedKeywords: ["Claude Code"],
  status: "researched",
});

const V1_FRONTMATTER: ResearchFrontmatter = {
  id: V1_ID,
  itemIds: [SAMPLE_ITEM.id],
  agent: "claude-code",
  templateId: "default",
  createdAt: "2026-05-10T03:00:00.000Z",
  updatedAt: null,
  reviewedAt: null,
  reviewedBy: null,
  supersedes: null,
};

const V1_BODY_MARKDOWN =
  "# Claude Code: shiny new feature\n\n## 要約\n\nNew feature.\n\n## 詳細\n\n- foo\n\n## 出典\n\n- 原文: https://anthropic.com/news/claude-code-shiny\n";

function buildResearchFileContent(
  fm: ResearchFrontmatter,
  body: string = V1_BODY_MARKDOWN,
): string {
  return matter.stringify(body, fm);
}

interface SetupOptions {
  itemStatus?: ItemStatus;
  /** Override v1 frontmatter (e.g. to start with a reviewed v1). */
  v1Frontmatter?: Partial<ResearchFrontmatter>;
  /** Pre-populate higher versions (e.g. v2 already on disk for v3 tests). */
  extraFiles?: Array<{ id: string; frontmatter: ResearchFrontmatter; body?: string }>;
}

async function setupWorkspace(
  opts: SetupOptions = {},
): Promise<{ workdir: string; v1Path: string }> {
  const workdir = await mkdtemp(join(tmpdir(), "agentic-watch-update-"));
  await mkdir(join(workdir, "items", SAMPLE_ITEM.sourceId), { recursive: true });
  await mkdir(join(workdir, "research"), { recursive: true });
  await mkdir(join(workdir, "templates"), { recursive: true });
  const item: Item = { ...SAMPLE_ITEM, status: opts.itemStatus ?? "researched" };
  await writeFile(
    join(workdir, "items", item.sourceId, `${item.id}.yaml`),
    stringifyYaml(item),
    "utf8",
  );
  const fm: ResearchFrontmatter = { ...V1_FRONTMATTER, ...opts.v1Frontmatter };
  const v1Path = join(workdir, "research", `${V1_ID}.md`);
  await writeFile(v1Path, buildResearchFileContent(fm), "utf8");
  for (const extra of opts.extraFiles ?? []) {
    await writeFile(
      join(workdir, "research", `${extra.id}.md`),
      buildResearchFileContent(extra.frontmatter, extra.body),
      "utf8",
    );
  }
  return { workdir, v1Path };
}

interface MockAdapterArgs {
  writer: (req: UpdateRequest) => Promise<void>;
  id?: AgentAdapter["id"];
}

function buildMockAdapter(args: MockAdapterArgs): {
  adapter: AgentAdapter;
  calls: UpdateRequest[];
} {
  const calls: UpdateRequest[] = [];
  const adapter: AgentAdapter = {
    id: args.id ?? "claude-code",
    research: async () => {
      throw new Error("research not used in update tests");
    },
    review: async () => {
      throw new Error("review not used in update tests");
    },
    update: async (req) => {
      calls.push(req);
      await args.writer(req);
    },
  };
  return { adapter, calls };
}

/**
 * Default well-behaved writer: emits a v+1 file whose frontmatter follows the
 * Phase 5 contract (supersedes set, createdAt preserved, review fields null,
 * agent stamped to the invoking agent).
 */
function wellBehavedWriter(opts: { updatedAt?: string; bodySuffix?: string } = {}) {
  return async (req: UpdateRequest) => {
    const newId = req.outputPath.replace(/^.*\//, "").replace(/\.md$/, "");
    const newFm: ResearchFrontmatter = {
      id: newId,
      itemIds: req.prevResearch.frontmatter.itemIds,
      agent: req.agent,
      templateId: req.prevResearch.frontmatter.templateId,
      createdAt: req.prevResearch.frontmatter.createdAt,
      updatedAt: opts.updatedAt ?? "2026-06-12T00:00:00.000Z",
      reviewedAt: null,
      reviewedBy: null,
      supersedes: req.prevResearch.frontmatter.id,
    };
    const body = `# Claude Code: shiny new feature\n\n## v${newId.match(/_v(\d+)$/)?.[1] ?? "?"} での変更点\n\n- updated\n${opts.bodySuffix ?? ""}\n\n## 要約\n\nUpdated content.\n\n## 詳細\n\n- new info\n\n## 出典\n\n- 原文: https://anthropic.com/news/claude-code-shiny\n`;
    await writeFile(req.outputPath, matter.stringify(body, newFm), "utf8");
  };
}

describe("cli/update", () => {
  let previousAdapter: AgentAdapter | undefined;

  afterEach(() => {
    if (previousAdapter) {
      registerAgentAdapter(previousAdapter);
    }
  });

  beforeEach(() => {
    previousAdapter = undefined;
  });

  it("generates v2 from v1 with supersedes pointing at the previous id", async () => {
    const { workdir, v1Path } = await setupWorkspace();
    const v1Original = await readFile(v1Path, "utf8");
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID, "--agent", "claude-code"], { cwd: workdir, io });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("claude-code");
    expect(calls[0].prevResearch.frontmatter.id).toBe(V1_ID);

    // v2 file exists with correct supersedes.
    const v2Path = join(workdir, "research", `${V2_ID}.md`);
    expect(await pathExists(v2Path)).toBe(true);
    const v2Body = await readFile(v2Path, "utf8");
    const v2Fm = matter(v2Body).data;
    expect(v2Fm.id).toBe(V2_ID);
    expect(v2Fm.supersedes).toBe(V1_ID);
    expect(v2Fm.itemIds).toEqual([SAMPLE_ITEM.id]);
    expect(v2Fm.templateId).toBe("default");
    expect(v2Fm.createdAt).toBe("2026-05-10T03:00:00.000Z");
    expect(v2Fm.reviewedAt).toBeNull();
    expect(v2Fm.reviewedBy).toBeNull();
    expect(v2Fm.agent).toBe("claude-code");

    // v1 file is untouched (immutable history).
    expect(await readFile(v1Path, "utf8")).toBe(v1Original);

    expect(captured.log.some((m) => m.includes("invoking claude-code adapter"))).toBe(true);
    expect(captured.log.some((m) => m.includes(`supersedes ${V1_ID}`))).toBe(true);
  });

  it("keeps items.yaml status unchanged when updating a researched item", async () => {
    const { workdir } = await setupWorkspace({ itemStatus: "researched" });
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(0);

    const itemRaw = await readFile(
      join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
      "utf8",
    );
    const item = parseYaml(itemRaw);
    // ADR-0008 / skill-design.md §8.4: update does not advance the item.
    expect(item.status).toBe("researched");
  });

  it("keeps items.yaml status unchanged when updating a reviewed item", async () => {
    const { workdir } = await setupWorkspace({
      itemStatus: "reviewed",
      v1Frontmatter: {
        reviewedAt: "2026-05-11T01:00:00.000Z",
        reviewedBy: "claude-code",
      },
    });
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(0);

    // items.yaml status stays at reviewed — the v1 review event is preserved.
    const itemRaw = await readFile(
      join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
      "utf8",
    );
    expect(parseYaml(itemRaw).status).toBe("reviewed");

    // v2 frontmatter resets reviewedAt / reviewedBy regardless of v1 state.
    const v2Body = await readFile(join(workdir, "research", `${V2_ID}.md`), "utf8");
    const v2Fm = matter(v2Body).data;
    expect(v2Fm.reviewedAt).toBeNull();
    expect(v2Fm.reviewedBy).toBeNull();
    expect(v2Fm.supersedes).toBe(V1_ID);
  });

  it("does not modify the v1 file when generating v2 (immutable history)", async () => {
    const { workdir, v1Path } = await setupWorkspace();
    const before = await readFile(v1Path, "utf8");
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    expect(await runUpdate([V1_ID], { cwd: workdir, io })).toBe(0);
    expect(await readFile(v1Path, "utf8")).toBe(before);
  });

  it("supports repeated update: v1 -> v2 -> v3 -> v4", async () => {
    const { workdir } = await setupWorkspace();
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    // v1 -> v2
    expect(await runUpdate([V1_ID], { cwd: workdir, io: captureIo().io })).toBe(0);
    expect(await pathExists(join(workdir, "research", `${V2_ID}.md`))).toBe(true);

    // v2 -> v3
    expect(await runUpdate([V2_ID], { cwd: workdir, io: captureIo().io })).toBe(0);
    expect(await pathExists(join(workdir, "research", `${V3_ID}.md`))).toBe(true);
    const v3Body = await readFile(join(workdir, "research", `${V3_ID}.md`), "utf8");
    expect(matter(v3Body).data.supersedes).toBe(V2_ID);

    // v3 -> v4
    expect(await runUpdate([V3_ID], { cwd: workdir, io: captureIo().io })).toBe(0);
    expect(await pathExists(join(workdir, "research", `${V4_ID}.md`))).toBe(true);
    const v4Body = await readFile(join(workdir, "research", `${V4_ID}.md`), "utf8");
    expect(matter(v4Body).data.supersedes).toBe(V3_ID);

    // All older files still on disk (immutable history).
    for (const id of [V1_ID, V2_ID, V3_ID, V4_ID]) {
      expect(await pathExists(join(workdir, "research", `${id}.md`))).toBe(true);
    }
  });

  it("resets reviewedAt / reviewedBy to null on v+1 even when v1 was reviewed", async () => {
    const { workdir } = await setupWorkspace({
      itemStatus: "reviewed",
      v1Frontmatter: {
        reviewedAt: "2026-05-11T01:00:00.000Z",
        reviewedBy: "gemini-cli",
      },
    });
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    expect(await runUpdate([V1_ID], { cwd: workdir, io })).toBe(0);
    // Adapter sees the reviewed v1 frontmatter — but its own output must reset.
    expect(calls[0].prevResearch.frontmatter.reviewedAt).toBe("2026-05-11T01:00:00.000Z");
    expect(calls[0].prevResearch.frontmatter.reviewedBy).toBe("gemini-cli");

    const v2Body = await readFile(join(workdir, "research", `${V2_ID}.md`), "utf8");
    const v2Fm = matter(v2Body).data;
    expect(v2Fm.reviewedAt).toBeNull();
    expect(v2Fm.reviewedBy).toBeNull();
  });

  it("auto-corrects frontmatter drift emitted by a misbehaving agent", async () => {
    const { workdir } = await setupWorkspace();
    // Adapter writes nearly-correct frontmatter but leaks v1's reviewedAt
    // through, changes templateId, and forgets to set supersedes.
    const { adapter } = buildMockAdapter({
      writer: async (req) => {
        const newId = req.outputPath.replace(/^.*\//, "").replace(/\.md$/, "");
        const driftFm: ResearchFrontmatter = {
          id: newId,
          itemIds: req.prevResearch.frontmatter.itemIds,
          agent: req.agent,
          templateId: "WRONG_TEMPLATE",
          createdAt: req.prevResearch.frontmatter.createdAt,
          updatedAt: "2026-06-12T00:00:00.000Z",
          reviewedAt: "2026-05-11T01:00:00.000Z", // leaked from v1
          reviewedBy: "gemini-cli",
          supersedes: null, // forgot
        };
        await writeFile(req.outputPath, matter.stringify("# body\n", driftFm), "utf8");
      },
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(captured.warn.some((m) => m.includes("auto-correcting"))).toBe(true);

    const v2Body = await readFile(join(workdir, "research", `${V2_ID}.md`), "utf8");
    const v2Fm = matter(v2Body).data;
    // Drift fields rewritten by the CLI.
    expect(v2Fm.templateId).toBe("default");
    expect(v2Fm.supersedes).toBe(V1_ID);
    expect(v2Fm.reviewedAt).toBeNull();
    expect(v2Fm.reviewedBy).toBeNull();
  });

  it("allows --agent to differ from v1's agent (agent is mutable across versions)", async () => {
    const { workdir } = await setupWorkspace();
    // Register a mock for gemini-cli; v1 was claude-code.
    const { adapter, calls } = buildMockAdapter({
      id: "gemini-cli",
      writer: wellBehavedWriter(),
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runUpdate([V1_ID, "--agent", "gemini-cli"], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].agent).toBe("gemini-cli");
    const v2Body = await readFile(join(workdir, "research", `${V2_ID}.md`), "utf8");
    expect(matter(v2Body).data.agent).toBe("gemini-cli");
  });

  it("refuses to overwrite an existing v+1 file", async () => {
    const v2Fm: ResearchFrontmatter = {
      ...V1_FRONTMATTER,
      id: V2_ID,
      supersedes: V1_ID,
    };
    const { workdir } = await setupWorkspace({
      extraFiles: [{ id: V2_ID, frontmatter: v2Fm }],
    });
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("already exists"))).toBe(true);
    // Adapter must NOT have been invoked.
    expect(calls).toHaveLength(0);
  });

  it("rejects a detected item (no v1 research exists to supersede)", async () => {
    // Manually craft a workspace where v1 exists on disk but the linked item
    // is still in `detected`. This is an inconsistent state, but defends
    // against future bugs where saveItems is out of sync.
    const { workdir } = await setupWorkspace({ itemStatus: "detected" });
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(
      captured.error.some((m) => m.includes("must be in status 'researched' or 'reviewed'")),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects a dismissed item", async () => {
    const { workdir } = await setupWorkspace({ itemStatus: "dismissed" });
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(
      captured.error.some((m) => m.includes("must be in status 'researched' or 'reviewed'")),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("errors when the predecessor research file is missing", async () => {
    const { workdir } = await setupWorkspace();
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate(["nonexistent_research_id_v1"], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("research file not found"))).toBe(true);
  });

  it("errors when the predecessor id has no _v<N> suffix", async () => {
    const { workdir } = await setupWorkspace();
    // Create a file without the version suffix.
    const badId = "20260510_no-version-suffix";
    const fm: ResearchFrontmatter = { ...V1_FRONTMATTER, id: badId };
    await writeFile(join(workdir, "research", `${badId}.md`), buildResearchFileContent(fm), "utf8");
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate([badId], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("expected <base>_v<N>"))).toBe(true);
  });

  it("errors when the predecessor frontmatter id mismatches the filename", async () => {
    const { workdir } = await setupWorkspace();
    // Write a v1 file whose frontmatter id does NOT match the filename.
    const fm: ResearchFrontmatter = { ...V1_FRONTMATTER, id: "DIFFERENT_v1" };
    await writeFile(join(workdir, "research", `${V1_ID}.md`), buildResearchFileContent(fm), "utf8");
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("does not match filename id"))).toBe(true);
  });

  it("rejects an invalid --agent value", async () => {
    const { workdir } = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID, "--agent", "wat"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("invalid --agent"))).toBe(true);
  });

  it("errors when <research-id> is missing", async () => {
    const { workdir } = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runUpdate([], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("missing <research-id>"))).toBe(true);
  });

  it("rejects path-escape attempts in <research-id>", async () => {
    const { workdir } = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runUpdate(["../../etc/passwd"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("invalid <research-id>"))).toBe(true);
  });

  it("accepts <research-id> with the .md extension", async () => {
    const { workdir } = await setupWorkspace();
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);
    const { io } = captureIo();
    const code = await runUpdate([`${V1_ID}.md`], { cwd: workdir, io });
    expect(code).toBe(0);
  });

  it("errors when the adapter fails to write the output file", async () => {
    const { workdir } = await setupWorkspace();
    const { adapter } = buildMockAdapter({
      writer: async () => {
        // Adapter "succeeds" but writes nothing.
      },
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("did not write"))).toBe(true);
  });

  it("propagates adapter exceptions as a non-zero exit", async () => {
    const { workdir, v1Path } = await setupWorkspace();
    const v1Original = await readFile(v1Path, "utf8");
    const { adapter } = buildMockAdapter({
      writer: async () => {
        throw new Error("simulated agent crash");
      },
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("simulated agent crash"))).toBe(true);
    // v1 file untouched.
    expect(await readFile(v1Path, "utf8")).toBe(v1Original);
  });

  it("falls back to radar.config.yaml `defaultResearchAgent` when --agent is omitted", async () => {
    const { workdir } = await setupWorkspace();
    // update borrows the research agent default per skill-design.md §8.2.
    await writeFile(
      join(workdir, "radar.config.yaml"),
      "defaultResearchAgent: gemini-cli\n",
      "utf8",
    );
    const { adapter, calls } = buildMockAdapter({
      id: "gemini-cli",
      writer: wellBehavedWriter(),
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].agent).toBe("gemini-cli");
  });

  it("surfaces radar.config.yaml schema violations", async () => {
    const { workdir } = await setupWorkspace();
    await writeFile(
      join(workdir, "radar.config.yaml"),
      "defaultResearchAgent: not-an-agent\n",
      "utf8",
    );
    const { io, captured } = captureIo();
    const code = await runUpdate([V1_ID], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("radar.config.yaml schema violation"))).toBe(true);
  });
});
