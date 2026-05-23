import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentAdapter, ReviewRequest } from "../../src/agents/index.js";
import { registerAgentAdapter } from "../../src/agents/index.js";
import { runReview } from "../../src/cli/review.js";
import type { Item, ResearchFrontmatter } from "../../src/schemas/index.js";
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

const RESEARCH_ID = "20260510_anthropic-news-claude-code-shiny-new-feature_v1";

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

const PRE_FRONTMATTER: ResearchFrontmatter = {
  id: RESEARCH_ID,
  itemIds: [SAMPLE_ITEM.id],
  agent: "claude-code",
  templateId: "default",
  createdAt: "2026-05-10T03:00:00.000Z",
  updatedAt: null,
  reviewedAt: null,
  reviewedBy: null,
};

const PRE_BODY_MARKDOWN =
  "# Claude Code: shiny new feature\n\n## 要約\n\nNew feature.\n\n## 詳細\n\n- foo\n\n## 出典\n\n- 原文: https://anthropic.com/news/claude-code-shiny\n";

function buildResearchFileContent(fm: ResearchFrontmatter): string {
  return matter.stringify(PRE_BODY_MARKDOWN, fm);
}

async function setupWorkspace(
  overrides: { itemStatus?: Item["status"]; preReviewedAt?: string | null } = {},
): Promise<{ workdir: string; researchPath: string }> {
  const workdir = await mkdtemp(join(tmpdir(), "feedradar-review-"));
  await mkdir(join(workdir, "items", SAMPLE_ITEM.sourceId), { recursive: true });
  await mkdir(join(workdir, "research"), { recursive: true });
  await mkdir(join(workdir, "templates"), { recursive: true });
  const item: Item = { ...SAMPLE_ITEM, status: overrides.itemStatus ?? "researched" };
  await writeFile(
    join(workdir, "items", item.sourceId, `${item.id}.yaml`),
    stringifyYaml(item),
    "utf8",
  );
  const fm: ResearchFrontmatter = {
    ...PRE_FRONTMATTER,
    reviewedAt: overrides.preReviewedAt ?? null,
    reviewedBy: overrides.preReviewedAt ? "claude-code" : null,
  };
  const researchPath = join(workdir, "research", `${RESEARCH_ID}.md`);
  await writeFile(researchPath, buildResearchFileContent(fm), "utf8");
  return { workdir, researchPath };
}

interface MockAdapterArgs {
  writer: (req: ReviewRequest) => Promise<void>;
  /** Override `id` so we can register the mock under a different agent slot if needed. */
  id?: AgentAdapter["id"];
}

function buildMockAdapter(args: MockAdapterArgs): {
  adapter: AgentAdapter;
  calls: ReviewRequest[];
} {
  const calls: ReviewRequest[] = [];
  const adapter: AgentAdapter = {
    id: args.id ?? "claude-code",
    research: async () => {
      throw new Error("research not used in review tests");
    },
    review: async (req) => {
      calls.push(req);
      await args.writer(req);
    },
  };
  return { adapter, calls };
}

/**
 * Default "well-behaved agent" writer: stamps reviewedAt/reviewedBy and
 * appends a `## レビュー (...)` section. Tests use this for the happy path
 * and override it for the misbehaving-agent scenarios.
 */
function wellBehavedWriter(reviewedAt = "2026-05-11T01:00:00.000Z") {
  return async (req: ReviewRequest) => {
    const updatedFm: ResearchFrontmatter = {
      ...req.researchFrontmatter,
      reviewedAt,
      reviewedBy: req.agent,
    };
    const reviewBlock = `\n\n## レビュー (${req.agent}, ${reviewedAt})\n\n### 事実関係\n\n- ok\n`;
    await writeFile(
      req.researchPath,
      matter.stringify(`${PRE_BODY_MARKDOWN}${reviewBlock}`, updatedFm),
      "utf8",
    );
  };
}

describe("cli/review", () => {
  let previousAdapter: AgentAdapter | undefined;

  afterEach(() => {
    if (previousAdapter) {
      registerAgentAdapter(previousAdapter);
    }
  });

  beforeEach(() => {
    previousAdapter = undefined;
  });

  it("runs end-to-end: stamps frontmatter, appends review block, transitions item to reviewed", async () => {
    const { workdir, researchPath } = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID, "--agent", "claude-code"], { cwd: workdir, io });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("claude-code");
    expect(calls[0].templateId).toBe("default");
    expect(calls[0].researchPath).toBe(researchPath);
    expect(calls[0].researchFrontmatter.reviewedAt).toBeNull();

    // Frontmatter post-conditions.
    const updatedBody = await readFile(researchPath, "utf8");
    const updatedFm = matter(updatedBody).data;
    expect(updatedFm.reviewedAt).toBe("2026-05-11T01:00:00.000Z");
    expect(updatedFm.reviewedBy).toBe("claude-code");

    // Review section appended.
    expect(updatedBody).toMatch(/## レビュー \(claude-code, 2026-05-11T01:00:00\.000Z\)/);

    // Item transitioned to reviewed.
    const itemRaw = await readFile(
      join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
      "utf8",
    );
    const item = parseYaml(itemRaw);
    expect(item.status).toBe("reviewed");

    expect(captured.log.some((m) => m.includes("invoking claude-code adapter"))).toBe(true);
    expect(captured.log.some((m) => m.includes("status -> reviewed"))).toBe(true);
  });

  it("defaults --agent to claude-code", async () => {
    const { workdir } = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].agent).toBe("claude-code");
  });

  it("loads templates/<id>.md and passes templateBody to the adapter", async () => {
    const { workdir } = await setupWorkspace();
    await writeFile(
      join(workdir, "templates", "default.md"),
      "# Default review template\n",
      "utf8",
    );
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].templateBody).toBe("# Default review template\n");
  });

  it("falls back to empty template body when templates/default.md is missing", async () => {
    const { workdir } = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].templateBody).toBe("");
  });

  it("refuses to re-review an already-reviewed research file", async () => {
    const { workdir } = await setupWorkspace({
      preReviewedAt: "2026-05-11T00:00:00.000Z",
      itemStatus: "reviewed",
    });
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("already reviewed"))).toBe(true);
    // Adapter must NOT have been invoked.
    expect(calls).toHaveLength(0);
  });

  it("rejects an item whose status is not 'researched'", async () => {
    const { workdir } = await setupWorkspace({ itemStatus: "detected" });
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("must be in status 'researched'"))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("errors when the research file is missing", async () => {
    const { workdir } = await setupWorkspace();
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview(["nonexistent_research_id"], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("research file not found"))).toBe(true);
  });

  it("errors when the linked item is missing", async () => {
    const { workdir, researchPath } = await setupWorkspace();
    // Rewrite the research frontmatter to reference an item that does not exist.
    const fm = { ...PRE_FRONTMATTER, itemIds: ["ghost-item-id"] };
    await writeFile(researchPath, buildResearchFileContent(fm), "utf8");

    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("no items/<id>.yaml found"))).toBe(true);
  });

  it("accepts gemini-cli as a valid review agent (adapter is now implemented)", async () => {
    // Phase 2 sub-issue D wires the gemini-cli adapter for review. The CLI
    // used to reject this with "not supported yet"; now the request reaches
    // the adapter, which (with the mock writer) succeeds end-to-end.
    const { workdir } = await setupWorkspace();
    const { adapter, calls } = buildMockAdapter({
      id: "gemini-cli",
      writer: wellBehavedWriter(),
    });
    previousAdapter = registerAgentAdapter(adapter);
    const { io } = captureIo();
    const code = await runReview([RESEARCH_ID, "--agent", "gemini-cli"], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].agent).toBe("gemini-cli");
  });

  it("falls back to radar.config.yaml `defaultReviewAgent` when --agent is omitted", async () => {
    const { workdir } = await setupWorkspace();
    // Set a non-default agent (gemini-cli) in the config and register a mock
    // adapter for it. The CLI should invoke that adapter, proving the config
    // value took effect (vs. falling back to the hardcoded claude-code
    // default).
    await writeFile(join(workdir, "radar.config.yaml"), "defaultReviewAgent: gemini-cli\n", "utf8");
    const { adapter, calls } = buildMockAdapter({
      id: "gemini-cli",
      writer: wellBehavedWriter(),
    });
    previousAdapter = registerAgentAdapter(adapter);
    const { io } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("gemini-cli");
  });

  it("explicit --agent overrides radar.config.yaml `defaultReviewAgent`", async () => {
    const { workdir } = await setupWorkspace();
    // Config says gemini-cli; CLI passes claude-code explicitly. Explicit wins.
    await writeFile(join(workdir, "radar.config.yaml"), "defaultReviewAgent: gemini-cli\n", "utf8");
    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runReview([RESEARCH_ID, "--agent", "claude-code"], { cwd: workdir, io });
    expect(code).toBe(0);
    expect(calls[0].agent).toBe("claude-code");
  });

  it("surfaces radar.config.yaml schema violations", async () => {
    const { workdir } = await setupWorkspace();
    await writeFile(
      join(workdir, "radar.config.yaml"),
      "defaultReviewAgent: not-an-agent\n",
      "utf8",
    );
    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("radar.config.yaml schema violation"))).toBe(true);
  });

  it("rejects an invalid --agent value", async () => {
    const { workdir } = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID, "--agent", "wat"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("invalid --agent"))).toBe(true);
  });

  it("errors when <research-id> is missing", async () => {
    const { workdir } = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runReview([], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("missing <research-id>"))).toBe(true);
  });

  it("rejects path-escape attempts in <research-id>", async () => {
    const { workdir } = await setupWorkspace();
    const { io, captured } = captureIo();
    const code = await runReview(["../../etc/passwd"], { cwd: workdir, io });
    expect(code).toBe(2);
    expect(captured.error.some((m) => m.includes("invalid <research-id>"))).toBe(true);
  });

  it("accepts <research-id> with or without the .md extension", async () => {
    const { workdir } = await setupWorkspace();
    const { adapter } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io } = captureIo();
    const code = await runReview([`${RESEARCH_ID}.md`], { cwd: workdir, io });
    expect(code).toBe(0);
  });

  it("rolls back when the adapter throws (research file and item status restored)", async () => {
    const { workdir, researchPath } = await setupWorkspace();
    const originalBody = await readFile(researchPath, "utf8");

    // Misbehaving adapter that writes partial content then throws.
    const { adapter, calls } = buildMockAdapter({
      writer: async (req) => {
        // Simulate the agent partially rewriting the file before crashing.
        await writeFile(req.researchPath, "PARTIAL\n", "utf8");
        throw new Error("simulated agent crash");
      },
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);

    // Research file restored.
    const afterBody = await readFile(researchPath, "utf8");
    expect(afterBody).toBe(originalBody);

    // Item status unchanged (still 'researched').
    const itemRaw = await readFile(
      join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
      "utf8",
    );
    const item = parseYaml(itemRaw);
    expect(item.status).toBe("researched");

    expect(captured.error.some((m) => m.includes("simulated agent crash"))).toBe(true);
    expect(captured.warn.some((m) => m.includes("rolled back"))).toBe(true);
  });

  it("rolls back when adapter forgets to stamp reviewedAt", async () => {
    const { workdir, researchPath } = await setupWorkspace();
    const originalBody = await readFile(researchPath, "utf8");

    const { adapter } = buildMockAdapter({
      writer: async (req) => {
        // Write a body but leave reviewedAt as null (matches pre-state) — the
        // CLI should detect the missing stamp and roll back.
        const body = matter.stringify(
          `${PRE_BODY_MARKDOWN}\n\n## レビュー (claude-code, 2026-05-11T01:00:00.000Z)\n\n- bogus\n`,
          req.researchFrontmatter,
        );
        await writeFile(req.researchPath, body, "utf8");
      },
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("did not stamp `reviewedAt`"))).toBe(true);

    const afterBody = await readFile(researchPath, "utf8");
    expect(afterBody).toBe(originalBody);

    const itemRaw = await readFile(
      join(workdir, "items", SAMPLE_ITEM.sourceId, `${SAMPLE_ITEM.id}.yaml`),
      "utf8",
    );
    expect(parseYaml(itemRaw).status).toBe("researched");
  });

  it("rolls back when adapter mutates immutable frontmatter (e.g. createdAt)", async () => {
    const { workdir, researchPath } = await setupWorkspace();
    const originalBody = await readFile(researchPath, "utf8");

    const { adapter } = buildMockAdapter({
      writer: async (req) => {
        const tampered: ResearchFrontmatter = {
          ...req.researchFrontmatter,
          createdAt: "2099-01-01T00:00:00.000Z", // changed!
          reviewedAt: "2026-05-11T01:00:00.000Z",
          reviewedBy: req.agent,
        };
        await writeFile(req.researchPath, matter.stringify(PRE_BODY_MARKDOWN, tampered), "utf8");
      },
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(captured.error.some((m) => m.includes("mutated immutable frontmatter"))).toBe(true);

    expect(await readFile(researchPath, "utf8")).toBe(originalBody);
  });

  it("rolls back when adapter stamps reviewedBy with the wrong agent", async () => {
    const { workdir, researchPath } = await setupWorkspace();
    const originalBody = await readFile(researchPath, "utf8");

    const { adapter } = buildMockAdapter({
      writer: async (req) => {
        const updatedFm: ResearchFrontmatter = {
          ...req.researchFrontmatter,
          reviewedAt: "2026-05-11T01:00:00.000Z",
          reviewedBy: "gemini-cli", // wrong agent!
        };
        await writeFile(req.researchPath, matter.stringify(PRE_BODY_MARKDOWN, updatedFm), "utf8");
      },
    });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(
      captured.error.some((m) => m.includes("reviewedBy='gemini-cli'") && m.includes("expected")),
    ).toBe(true);

    expect(await readFile(researchPath, "utf8")).toBe(originalBody);
  });

  it("rolls back the research file when the item status write fails", async () => {
    const { workdir, researchPath } = await setupWorkspace();
    const originalBody = await readFile(researchPath, "utf8");

    // Use a writer that does the well-behaved review AND then sabotages the
    // items directory mid-execution. This simulates a filesystem fault that
    // appears between the adapter succeeding and the CLI's saveItems call —
    // exactly the partial-failure window the atomic update strategy must
    // cover. We replace `items/<sourceId>/` with a regular file so
    // `mkdir({recursive: true})` throws ENOTDIR. Replacing the dir before
    // `runReview` is started would break the pre-adapter `findItemsForResearch`
    // lookup, so the sabotage has to happen *inside* the adapter callback.
    const itemDir = join(workdir, "items", SAMPLE_ITEM.sourceId);
    const { adapter } = buildMockAdapter({
      writer: async (req) => {
        await wellBehavedWriter()(req);
        await rm(itemDir, { recursive: true });
        await writeFile(itemDir, "not-a-directory", "utf8");
      },
    });
    previousAdapter = registerAgentAdapter(adapter);

    try {
      const { io, captured } = captureIo();
      const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
      expect(code).toBe(1);
      expect(captured.error.some((m) => m.includes("failed to update item status"))).toBe(true);
      // Items dir is sabotaged so the items-side restore also fails. The CLI
      // surfaces "rollback partially failed" + the inconsistent-state hint so
      // the user knows manual recovery is required. The research file side
      // of the snapshot still restores successfully.
      expect(captured.error.some((m) => m.includes("rollback partially failed"))).toBe(true);
      expect(
        captured.error.some((m) => m.includes("workspace may be in an inconsistent state")),
      ).toBe(true);

      // Research file restored (the file write half of the rollback succeeded).
      expect(await readFile(researchPath, "utf8")).toBe(originalBody);
    } finally {
      await rm(itemDir).catch(() => undefined);
    }
  });

  it("rejects research files with malformed pre-review frontmatter", async () => {
    const { workdir, researchPath } = await setupWorkspace();
    // Write a frontmatter missing required fields.
    const bad = {
      id: RESEARCH_ID,
      // itemIds, agent, etc. missing
    };
    await writeFile(researchPath, matter.stringify("body\n", bad), "utf8");

    const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
    previousAdapter = registerAgentAdapter(adapter);

    const { io, captured } = captureIo();
    const code = await runReview([RESEARCH_ID], { cwd: workdir, io });
    expect(code).toBe(1);
    expect(
      captured.error.some((m) =>
        m.includes("research frontmatter does not match ResearchFrontmatterSchema"),
      ),
    ).toBe(true);
    // Adapter should not have been invoked since the pre-check failed.
    expect(calls).toHaveLength(0);
  });

  describe("batch mode (--batch, #250)", () => {
    /**
     * Seed `n` un-reviewed research files paired with linked items in the
     * given `itemStatus`. Mirrors the structure of `setupWorkspace` but
     * scaled out so batch mode has something to walk. Each pair carries a
     * unique source id so `loadItems` partitions them deterministically.
     */
    async function setupBatchWorkspace(
      n: number,
      itemStatus: Item["status"] = "researched",
    ): Promise<{
      workdir: string;
      pairs: Array<{ researchId: string; itemId: string; sourceId: string }>;
    }> {
      const workdir = await mkdtemp(join(tmpdir(), "feedradar-review-batch-"));
      const pairs: Array<{ researchId: string; itemId: string; sourceId: string }> = [];
      for (let i = 0; i < n; i++) {
        const sourceId = `src-${i}`;
        const itemId = `item-${i}-${"a".repeat(8)}`;
        const researchId = `2026051${i}_src-${i}-claude_v1`;
        const createdAt = `2026-05-1${i}T00:00:00.000Z`;
        const item: Item = ItemSchema.parse({
          id: itemId,
          sourceId,
          title: `Item ${i}`,
          url: `https://example.com/${i}`,
          publishedAt: createdAt,
          fetchedAt: createdAt,
          matchedKeywords: ["claude-code", `tag-${i}`],
          status: itemStatus,
        });
        await mkdir(join(workdir, "items", sourceId), { recursive: true });
        await writeFile(
          join(workdir, "items", sourceId, `${itemId}.yaml`),
          stringifyYaml(item),
          "utf8",
        );
        await mkdir(join(workdir, "research"), { recursive: true });
        const fm: ResearchFrontmatter = {
          id: researchId,
          itemIds: [itemId],
          agent: "claude-code",
          templateId: "default",
          createdAt,
          updatedAt: null,
          reviewedAt: null,
          reviewedBy: null,
        };
        await writeFile(
          join(workdir, "research", `${researchId}.md`),
          buildResearchFileContent(fm),
          "utf8",
        );
        pairs.push({ researchId, itemId, sourceId });
      }
      await mkdir(join(workdir, "templates"), { recursive: true });
      return { workdir, pairs };
    }

    it("walks researched items and transitions them to reviewed (#250)", async () => {
      const { workdir, pairs } = await setupBatchWorkspace(3);
      const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runReview(["--batch", "--status", "researched"], { cwd: workdir, io });

      expect(code).toBe(0);
      expect(calls).toHaveLength(3);
      // Each linked item transitioned researched → reviewed (ADR-0008).
      for (const { itemId, sourceId } of pairs) {
        const raw = await readFile(join(workdir, "items", sourceId, `${itemId}.yaml`), "utf8");
        expect(parseYaml(raw).status).toBe("reviewed");
      }
      // Batch summary surfaces.
      expect(captured.log.some((m) => m.includes("--batch will process 3"))).toBe(true);
      expect(captured.log.some((m) => m.includes("--batch completed 3"))).toBe(true);
    });

    it("defaults --status to researched", async () => {
      const { workdir, pairs } = await setupBatchWorkspace(1);
      const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runReview(["--batch"], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      const raw = await readFile(
        join(workdir, "items", pairs[0].sourceId, `${pairs[0].itemId}.yaml`),
        "utf8",
      );
      expect(parseYaml(raw).status).toBe("reviewed");
    });

    it("rejects --status values other than researched", async () => {
      const { workdir } = await setupBatchWorkspace(1);
      for (const bogus of ["detected", "reviewed", "dismissed", "triaged_research"]) {
        const { io, captured } = captureIo();
        const code = await runReview(["--batch", "--status", bogus], { cwd: workdir, io });
        expect(code, `--status ${bogus} should be rejected`).toBe(2);
        expect(
          captured.error.some((m) => m.includes("invalid --status") && m.includes(bogus)),
        ).toBe(true);
      }
    });

    it("respects --max-items cap and announces dropped excess", async () => {
      const { workdir } = await setupBatchWorkspace(5);
      const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runReview(["--batch", "--max-items", "2"], { cwd: workdir, io });
      expect(code).toBe(0);
      expect(calls).toHaveLength(2);
      expect(
        captured.warn.some(
          (m) => m.includes("--max-items 2 cap reached") && m.includes("dropping 3"),
        ),
      ).toBe(true);
    });

    it("filters by --filter-tags against linked items' matchedKeywords", async () => {
      const { workdir, pairs } = await setupBatchWorkspace(3);
      // Override item 1 to drop the shared `claude-code` tag.
      const rewritten: Item = ItemSchema.parse({
        id: pairs[1].itemId,
        sourceId: pairs[1].sourceId,
        title: `Item 1`,
        url: `https://example.com/1`,
        publishedAt: "2026-05-11T00:00:00.000Z",
        fetchedAt: "2026-05-11T00:00:00.000Z",
        matchedKeywords: ["other-topic"],
        status: "researched",
      });
      await writeFile(
        join(workdir, "items", pairs[1].sourceId, `${pairs[1].itemId}.yaml`),
        stringifyYaml(rewritten),
        "utf8",
      );
      const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runReview(["--batch", "--filter-tags", "claude-code"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(0);
      // Only pairs[0] and pairs[2] match the filter.
      expect(calls).toHaveLength(2);
    });

    it("skips research files whose linked items are not in --status researched", async () => {
      // 2 researched pairs, plus 1 pair stuck at detected. The latter must
      // be skipped (would otherwise trip the single-review path's status
      // check after the agent had already run).
      const { workdir, pairs } = await setupBatchWorkspace(2);
      const stuckSource = "src-stuck";
      const stuckItem = "stuck-item-aaaaaaaa";
      const stuckResearch = "20260520_stuck_v1";
      await mkdir(join(workdir, "items", stuckSource), { recursive: true });
      await writeFile(
        join(workdir, "items", stuckSource, `${stuckItem}.yaml`),
        stringifyYaml(
          ItemSchema.parse({
            id: stuckItem,
            sourceId: stuckSource,
            title: "Stuck",
            url: "https://example.com/stuck",
            publishedAt: "2026-05-20T00:00:00.000Z",
            fetchedAt: "2026-05-20T00:00:00.000Z",
            matchedKeywords: ["x"],
            status: "detected",
          }),
        ),
        "utf8",
      );
      const stuckFm: ResearchFrontmatter = {
        id: stuckResearch,
        itemIds: [stuckItem],
        agent: "claude-code",
        templateId: "default",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      };
      await writeFile(
        join(workdir, "research", `${stuckResearch}.md`),
        buildResearchFileContent(stuckFm),
        "utf8",
      );

      const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
      previousAdapter = registerAgentAdapter(adapter);

      const { io } = captureIo();
      const code = await runReview(["--batch", "--status", "researched"], { cwd: workdir, io });
      expect(code).toBe(0);
      // Only the 2 properly-researched pairs were reviewed; the stuck one
      // stayed untouched.
      expect(calls).toHaveLength(2);
      for (const { itemId, sourceId } of pairs) {
        const raw = await readFile(join(workdir, "items", sourceId, `${itemId}.yaml`), "utf8");
        expect(parseYaml(raw).status).toBe("reviewed");
      }
      const stuckRaw = await readFile(
        join(workdir, "items", stuckSource, `${stuckItem}.yaml`),
        "utf8",
      );
      expect(parseYaml(stuckRaw).status).toBe("detected");
    });

    it("skips already-reviewed research files (idempotent)", async () => {
      const { workdir } = await setupBatchWorkspace(2);
      // Stamp one research file as already reviewed.
      const reviewedFm: ResearchFrontmatter = {
        id: "20260510_src-0-claude_v1",
        itemIds: ["item-0-aaaaaaaa"],
        agent: "claude-code",
        templateId: "default",
        createdAt: "2026-05-10T00:00:00.000Z",
        updatedAt: null,
        reviewedAt: "2026-05-11T00:00:00.000Z",
        reviewedBy: "claude-code",
      };
      await writeFile(
        join(workdir, "research", "20260510_src-0-claude_v1.md"),
        buildResearchFileContent(reviewedFm),
        "utf8",
      );
      const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
      previousAdapter = registerAgentAdapter(adapter);
      const { io } = captureIo();
      const code = await runReview(["--batch"], { cwd: workdir, io });
      expect(code).toBe(0);
      // Only the un-reviewed pair was processed.
      expect(calls).toHaveLength(1);
    });

    it("emits a no-match log when zero research files satisfy the filter", async () => {
      const { workdir } = await setupBatchWorkspace(2);
      const { adapter, calls } = buildMockAdapter({ writer: wellBehavedWriter() });
      previousAdapter = registerAgentAdapter(adapter);
      const { io, captured } = captureIo();
      const code = await runReview(["--batch", "--filter-tags", "nonexistent-tag"], {
        cwd: workdir,
        io,
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(
        captured.log.some((m) => m.includes("--batch matched 0") && m.includes("nonexistent-tag")),
      ).toBe(true);
    });

    it("rejects --batch combined with positional <research-id>", async () => {
      const { workdir, pairs } = await setupBatchWorkspace(1);
      const { io, captured } = captureIo();
      const code = await runReview(["--batch", pairs[0].researchId], { cwd: workdir, io });
      expect(code).toBe(2);
      expect(captured.error.some((m) => m.includes("incompatible with positional"))).toBe(true);
    });

    it("rejects --status / --max-items / --filter-tags outside of --batch", async () => {
      const { workdir, pairs } = await setupBatchWorkspace(1);
      for (const [flags, expectedSub] of [
        [["--status", "researched"], "--status requires --batch"],
        [["--max-items", "2"], "--max-items requires --batch"],
        [["--filter-tags", "a"], "--filter-tags requires --batch"],
      ] as const) {
        const { io, captured } = captureIo();
        const code = await runReview([pairs[0].researchId, ...flags], { cwd: workdir, io });
        expect(code, `${flags.join(" ")} should be rejected`).toBe(2);
        expect(captured.error.some((m) => m.includes(expectedSub))).toBe(true);
      }
    });

    it("halts the batch when an inner review invocation fails", async () => {
      const { workdir, pairs } = await setupBatchWorkspace(3);
      let invocations = 0;
      const { adapter } = buildMockAdapter({
        writer: async (req) => {
          invocations += 1;
          if (invocations === 2) {
            throw new Error("simulated adapter crash on the 2nd item");
          }
          await wellBehavedWriter()(req);
        },
      });
      previousAdapter = registerAgentAdapter(adapter);

      const { io, captured } = captureIo();
      const code = await runReview(["--batch"], { cwd: workdir, io });
      expect(code).toBe(1);
      // First call succeeded; second crashed (rolled back to researched);
      // third never reached.
      expect(invocations).toBe(2);
      expect(captured.error.some((m) => m.includes("--batch halted on research"))).toBe(true);
      // First pair already transitioned to reviewed before the crash; the
      // crashed pair stayed researched per the single-review rollback path.
      const first = await readFile(
        join(workdir, "items", pairs[0].sourceId, `${pairs[0].itemId}.yaml`),
        "utf8",
      );
      expect(parseYaml(first).status).toBe("reviewed");
      const second = await readFile(
        join(workdir, "items", pairs[1].sourceId, `${pairs[1].itemId}.yaml`),
        "utf8",
      );
      expect(parseYaml(second).status).toBe("researched");
    });
  });
});
