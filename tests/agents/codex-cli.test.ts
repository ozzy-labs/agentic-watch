import { describe, expect, it, vi } from "vitest";
import { createCodexCliAdapter } from "../../src/agents/codex-cli.js";
import type { ResearchRequest, ReviewRequest, UpdateRequest } from "../../src/agents/index.js";
import type { Item, ResearchFrontmatter } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * Extract + parse the trailing ```json fence``` from a FEEDRADAR payload block
 * (#272). The adapter now streams the payload block on stdin; structured
 * fields live in the fence, while the <untrusted_item> boundary (ADR-0009 M1c)
 * wraps the upstream content in the block body above it.
 */
function payloadJson(stdin: string): unknown {
  const m = stdin.match(/```json\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`no JSON fence found in payload:\n${stdin}`);
  return JSON.parse(m[1]);
}

const SAMPLE_ITEM: Item = ItemSchema.parse({
  id: "anthropic-news-2026-05-10-claude-code",
  sourceId: "anthropic-news",
  title: "Claude Code: shiny new feature",
  url: "https://anthropic.com/news/claude-code-shiny",
  publishedAt: "2026-05-10T00:00:00.000Z",
  fetchedAt: "2026-05-10T01:00:00.000Z",
  summary: "New feature in Claude Code.",
  matchedKeywords: ["Claude Code"],
  status: "detected",
});

const SAMPLE_RESEARCH_FM: ResearchFrontmatter = {
  id: "20260510_anthropic-news-claude-code-shiny-new-feature_v1",
  itemIds: [SAMPLE_ITEM.id],
  agent: "codex-cli",
  templateId: "default",
  createdAt: "2026-05-10T03:00:00.000Z",
  updatedAt: null,
  reviewedAt: null,
  reviewedBy: null,
};

function buildResearchRequest(overrides: Partial<ResearchRequest> = {}): ResearchRequest {
  return {
    agent: "codex-cli",
    templateId: "default",
    templateBody: "",
    items: [SAMPLE_ITEM],
    outputPath: "/tmp/feedradar-test/research/sample.md",
    cwd: "/tmp/feedradar-test",
    ...overrides,
  };
}

function buildReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    agent: "codex-cli",
    templateId: "default",
    templateBody: "",
    researchPath: "/tmp/feedradar-test/research/sample.md",
    researchFrontmatter: SAMPLE_RESEARCH_FM,
    researchBody: "---\nstub: true\n---\n# body\n",
    cwd: "/tmp/feedradar-test",
    ...overrides,
  };
}

function buildUpdateRequest(overrides: Partial<UpdateRequest> = {}): UpdateRequest {
  return {
    agent: "codex-cli",
    templateId: "default",
    templateBody: "",
    prevResearch: {
      frontmatter: SAMPLE_RESEARCH_FM,
      body: "---\nid: stub\n---\n# v1 body\n",
    },
    items: [SAMPLE_ITEM],
    outputPath:
      "/tmp/feedradar-test/research/20260510_anthropic-news-claude-code-shiny-new-feature_v2.md",
    cwd: "/tmp/feedradar-test",
    ...overrides,
  };
}

describe("agents/codex-cli adapter", () => {
  describe("research", () => {
    it("invokes the runner with the request cwd and JSON stdin payload", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
      const adapter = createCodexCliAdapter({ run });
      const req = buildResearchRequest();

      await adapter.research(req);

      expect(run).toHaveBeenCalledTimes(1);
      const [prompt, options] = run.mock.calls[0];

      // The thin argv prompt references the research SKILL; the outputPath /
      // item id / untrusted content ride on the stdin payload block (#272).
      expect(prompt).toContain(".agents/skills/research/SKILL.md");
      expect(options.stdin).toContain(req.outputPath);
      expect(options.stdin).toContain(SAMPLE_ITEM.id);

      // Item title / summary / raw must be inside the boundary marker pair
      // (ADR-0009 M1c). The opening / closing tags and the upstream-sourced
      // title both have to be present.
      expect(options.stdin).toContain("<untrusted_item>");
      expect(options.stdin).toContain("</untrusted_item>");
      expect(options.stdin).toContain(SAMPLE_ITEM.title);

      // cwd is forwarded so `codex exec --cd <cwd>` is rooted at the workspace.
      expect(options.cwd).toBe(req.cwd);

      // The stdin payload block carries the full ResearchRequest in its fence.
      const stdinJson = payloadJson(options.stdin);
      expect(stdinJson).toEqual({
        agent: "codex-cli",
        templateId: "default",
        templateBody: "",
        items: [SAMPLE_ITEM],
        outputPath: req.outputPath,
      });
    });

    it("throws a user-friendly error when codex CLI is not in PATH (ENOENT)", async () => {
      const run = vi
        .fn()
        .mockRejectedValue(
          new Error(
            "codex CLI not found in PATH — install Codex CLI and authenticate (`codex login`) before running `radar research` / `review`.",
          ),
        );
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /codex CLI not found in PATH/,
      );
    });

    it("surfaces an auth-error hint when codex exits non-zero with an unauth message", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: "Error: 401 Unauthorized. Please run `codex login`.",
      });
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /codex CLI is not authenticated/,
      );
    });

    it("includes the exit code and tail output when codex exits non-zero generically", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 2,
        stdout: "",
        stderr: "boom: something went wrong\n",
      });
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /codex CLI exited with code 2.*boom: something went wrong/s,
      );
    });

    it("falls back to stdout tail when stderr is empty on non-zero exit", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 3,
        stdout: "context lost",
        stderr: "",
      });
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /codex CLI exited with code 3.*context lost/s,
      );
    });
  });

  describe("review", () => {
    it("invokes the runner with the review SKILL prompt and the researchPath payload", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
      const adapter = createCodexCliAdapter({ run });
      const req = buildReviewRequest();

      await adapter.review(req);

      expect(run).toHaveBeenCalledTimes(1);
      const [prompt, options] = run.mock.calls[0];
      expect(prompt).toContain(".agents/skills/review/SKILL.md");
      expect(options.stdin).toContain(req.researchPath);
      expect(options.stdin).toContain("codex-cli");

      // The predecessor research body (untrusted, upstream-derived) is wrapped
      // in the boundary marker pair (ADR-0009 M1c) on stdin.
      expect(options.stdin).toContain("<untrusted_item>");
      expect(options.stdin).toContain("</untrusted_item>");
      expect(options.stdin).toContain(req.researchBody);

      expect(options.cwd).toBe(req.cwd);

      const stdinJson = payloadJson(options.stdin);
      expect(stdinJson).toEqual({
        agent: "codex-cli",
        templateId: "default",
        templateBody: "",
        researchPath: req.researchPath,
        researchFrontmatter: SAMPLE_RESEARCH_FM,
        researchBody: req.researchBody,
      });
    });

    it("surfaces an auth-error hint when codex exits non-zero with `codex login` in stderr", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: "you need to run `codex login` first",
      });
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.review(buildReviewRequest())).rejects.toThrow(
        /codex CLI is not authenticated/,
      );
    });

    it("throws the generic exit-code error when no auth marker is found", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: "ENOSPC: no space left on device",
      });
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.review(buildReviewRequest())).rejects.toThrow(
        /codex CLI exited with code 1.*ENOSPC/s,
      );
    });

    it("propagates ENOENT-style errors from the runner", async () => {
      const run = vi
        .fn()
        .mockRejectedValue(new Error("codex CLI not found in PATH — install Codex CLI"));
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.review(buildReviewRequest())).rejects.toThrow(/codex CLI not found/);
    });
  });

  describe("update", () => {
    it("invokes the runner with the update SKILL prompt and predecessor id", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
      const adapter = createCodexCliAdapter({ run });
      const req = buildUpdateRequest();

      await adapter.update(req);

      expect(run).toHaveBeenCalledTimes(1);
      const [prompt, options] = run.mock.calls[0];

      expect(prompt).toContain(".agents/skills/update/SKILL.md");
      expect(options.stdin).toContain(req.outputPath);
      // Predecessor id is the supersedes target we instruct the agent to write.
      expect(options.stdin).toContain(SAMPLE_RESEARCH_FM.id);
      expect(options.stdin).toContain(`supersedes: ${SAMPLE_RESEARCH_FM.id}`);

      // Both the predecessor research body and per-item title/summary/raw
      // must sit inside the boundary marker pair (ADR-0009 M1c) on stdin.
      expect(options.stdin).toContain("<untrusted_item>");
      expect(options.stdin).toContain("</untrusted_item>");
      expect(options.stdin).toContain(req.prevResearch.body);
      expect(options.stdin).toContain(SAMPLE_ITEM.title);

      expect(options.cwd).toBe(req.cwd);

      const stdinJson = payloadJson(options.stdin);
      expect(stdinJson).toEqual({
        agent: "codex-cli",
        templateId: "default",
        templateBody: "",
        prevResearch: req.prevResearch,
        items: req.items,
        outputPath: req.outputPath,
      });
    });

    it("surfaces an auth-error hint when codex exits non-zero with an unauth message", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: "Error: 401 Unauthorized. Please run `codex login`.",
      });
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.update(buildUpdateRequest())).rejects.toThrow(
        /codex CLI is not authenticated/,
      );
    });

    it("includes the exit code and stderr tail on generic non-zero exit", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 2,
        stdout: "",
        stderr: "boom: update prompt rejected\n",
      });
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.update(buildUpdateRequest())).rejects.toThrow(
        /codex CLI exited with code 2.*boom: update prompt rejected/s,
      );
    });

    it("propagates ENOENT-style errors from the runner", async () => {
      const run = vi
        .fn()
        .mockRejectedValue(new Error("codex CLI not found in PATH — install Codex CLI"));
      const adapter = createCodexCliAdapter({ run });

      await expect(adapter.update(buildUpdateRequest())).rejects.toThrow(/codex CLI not found/);
    });
  });

  describe("research (multi-item digest, ADR-0011 §1)", () => {
    const SECOND_ITEM: Item = ItemSchema.parse({
      id: "hacker-news-39876543-claude-code",
      sourceId: "hacker-news",
      title: "Show HN: claude-code in production",
      url: "https://news.ycombinator.com/item?id=39876543",
      publishedAt: "2026-05-11T12:00:00.000Z",
      fetchedAt: "2026-05-11T12:30:00.000Z",
      summary: "We migrated our research pipeline to claude-code.",
      matchedKeywords: ["Claude Code"],
      status: "detected",
    });
    const THIRD_ITEM: Item = ItemSchema.parse({
      id: "anthropic-news-2026-05-12-anthropic-funding",
      sourceId: "anthropic-news",
      title: "Anthropic funding round",
      url: "https://anthropic.com/news/funding",
      publishedAt: "2026-05-12T00:00:00.000Z",
      fetchedAt: "2026-05-12T01:00:00.000Z",
      summary: "New round closed.",
      matchedKeywords: ["Anthropic"],
      status: "detected",
    });

    it("includes every item's id, url, and untrusted content in the prompt", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const adapter = createCodexCliAdapter({ run });
      const items = [SAMPLE_ITEM, SECOND_ITEM, THIRD_ITEM];
      await adapter.research(buildResearchRequest({ items }));

      const [, options] = run.mock.calls[0];
      const block = options.stdin;
      for (const item of items) {
        expect(block).toContain(item.id);
        expect(block).toContain(item.url);
        expect(block).toContain(item.title);
        if (item.summary !== undefined) {
          expect(block).toContain(item.summary);
        }
      }
      expect(block).toContain(items.map((i) => i.id).join(", "));

      const stdinJson = payloadJson(options.stdin) as { items: Item[] };
      expect(stdinJson.items).toEqual(items);
    });

    it("labels each item with an `### Item k of N` heading and one boundary marker per item", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const adapter = createCodexCliAdapter({ run });
      const items = [SAMPLE_ITEM, SECOND_ITEM, THIRD_ITEM];
      await adapter.research(buildResearchRequest({ items }));

      const [, options] = run.mock.calls[0];
      const block = options.stdin;
      expect(block).toContain("### Item 1 of 3");
      expect(block).toContain("### Item 2 of 3");
      expect(block).toContain("### Item 3 of 3");
      // Closing-tag count = wrapped-item count (the M2a guidance line mentions
      // "<untrusted_item>" once without a closing tag).
      const pairCount = (block.match(/<\/untrusted_item>/g) ?? []).length;
      expect(pairCount).toBe(3);
    });

    it("emits no `### Item k of N` heading for a single-item array (regression guard)", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const adapter = createCodexCliAdapter({ run });
      await adapter.research(buildResearchRequest());

      const [, options] = run.mock.calls[0];
      const block = options.stdin;
      expect(block).not.toContain("### Item 1 of 1");
      const pairCount = (block.match(/<\/untrusted_item>/g) ?? []).length;
      expect(pairCount).toBe(1);
    });
  });

  describe("update (multi-item digest, ADR-0011 §4)", () => {
    const SECOND_ITEM: Item = ItemSchema.parse({
      id: "hacker-news-39876543-claude-code",
      sourceId: "hacker-news",
      title: "Show HN: claude-code in production",
      url: "https://news.ycombinator.com/item?id=39876543",
      publishedAt: "2026-05-11T12:00:00.000Z",
      fetchedAt: "2026-05-11T12:30:00.000Z",
      summary: "Production migration writeup.",
      matchedKeywords: ["Claude Code"],
      status: "researched",
    });

    it("renders every digest item under its `### Item k of N` heading inside the update prompt", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const adapter = createCodexCliAdapter({ run });
      const items = [SAMPLE_ITEM, SECOND_ITEM];
      await adapter.update(buildUpdateRequest({ items }));

      const [, options] = run.mock.calls[0];
      const block = options.stdin;
      expect(block).toContain("### Item 1 of 2");
      expect(block).toContain("### Item 2 of 2");
      expect(block).toContain(SAMPLE_ITEM.id);
      expect(block).toContain(SECOND_ITEM.id);
      // Predecessor body + 2 items = 3 boundary marker pairs (counted via the
      // closing tag; the M2a guidance line mentions the open tag once more).
      const pairCount = (block.match(/<\/untrusted_item>/g) ?? []).length;
      expect(pairCount).toBe(3);

      const stdinJson = payloadJson(options.stdin) as { items: Item[] };
      expect(stdinJson.items).toEqual(items);
    });
  });
});
