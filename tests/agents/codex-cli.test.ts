import { describe, expect, it, vi } from "vitest";
import { createCodexCliAdapter } from "../../src/agents/codex-cli.js";
import type { ResearchRequest, ReviewRequest, UpdateRequest } from "../../src/agents/index.js";
import type { Item, ResearchFrontmatter } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

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
    outputPath: "/tmp/agentic-watch-test/research/sample.md",
    cwd: "/tmp/agentic-watch-test",
    ...overrides,
  };
}

function buildReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    agent: "codex-cli",
    templateId: "default",
    templateBody: "",
    researchPath: "/tmp/agentic-watch-test/research/sample.md",
    researchFrontmatter: SAMPLE_RESEARCH_FM,
    researchBody: "---\nstub: true\n---\n# body\n",
    cwd: "/tmp/agentic-watch-test",
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
      "/tmp/agentic-watch-test/research/20260510_anthropic-news-claude-code-shiny-new-feature_v2.md",
    cwd: "/tmp/agentic-watch-test",
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

      // The prompt should reference the research SKILL and the outputPath so
      // Codex knows where to write the report.
      expect(prompt).toContain(".agents/skills/research/SKILL.md");
      expect(prompt).toContain(req.outputPath);
      expect(prompt).toContain(SAMPLE_ITEM.id);

      // Item title / summary / raw must be inside the boundary marker pair
      // (ADR-0009 M1c). The opening / closing tags and the upstream-sourced
      // title both have to be present.
      expect(prompt).toContain("<untrusted_item>");
      expect(prompt).toContain("</untrusted_item>");
      expect(prompt).toContain(SAMPLE_ITEM.title);

      // cwd is forwarded so `codex exec --cd <cwd>` is rooted at the workspace.
      expect(options.cwd).toBe(req.cwd);

      // stdin is a JSON document with the full ResearchRequest payload.
      const stdinJson = JSON.parse(options.stdin);
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
            "codex CLI not found in PATH — install Codex CLI and authenticate (`codex login`) before running `agentic-watch research` / `review`.",
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
      expect(prompt).toContain(req.researchPath);
      expect(prompt).toContain("codex-cli");

      // The predecessor research body (untrusted, upstream-derived) is wrapped
      // in the boundary marker pair (ADR-0009 M1c).
      expect(prompt).toContain("<untrusted_item>");
      expect(prompt).toContain("</untrusted_item>");
      expect(prompt).toContain(req.researchBody);

      expect(options.cwd).toBe(req.cwd);

      const stdinJson = JSON.parse(options.stdin);
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
      expect(prompt).toContain(req.outputPath);
      // Predecessor id is the supersedes target we instruct the agent to write.
      expect(prompt).toContain(SAMPLE_RESEARCH_FM.id);
      expect(prompt).toContain(`supersedes: ${SAMPLE_RESEARCH_FM.id}`);

      // Both the predecessor research body and per-item title/summary/raw
      // must sit inside the boundary marker pair (ADR-0009 M1c).
      expect(prompt).toContain("<untrusted_item>");
      expect(prompt).toContain("</untrusted_item>");
      expect(prompt).toContain(req.prevResearch.body);
      expect(prompt).toContain(SAMPLE_ITEM.title);

      expect(options.cwd).toBe(req.cwd);

      const stdinJson = JSON.parse(options.stdin);
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
});
