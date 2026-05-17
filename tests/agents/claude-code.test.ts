import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeAdapter } from "../../src/agents/claude-code.js";
import type { ResearchRequest, ReviewRequest, UpdateRequest } from "../../src/agents/index.js";
import type { Item, ResearchFrontmatter } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * The claude-code adapter shells out to the `claude` CLI via child_process.
 * Tests here lock down the spawn boundary — prompt content, stdin payload
 * shape, exit-code propagation — without ever invoking the real CLI.
 *
 * Mirror of `codex-cli.test.ts` / `copilot.test.ts` / `gemini-cli.test.ts`,
 * filed to close the Phase 2 coverage gap surfaced in #58 / #70.
 *
 * Unlike codex / copilot / gemini, claude-code's runner does NOT do auth-error
 * remapping at the adapter level; it just propagates exit code + stderr tail.
 * (The ENOENT-to-friendly-message remapping happens inside `runClaudeCli`
 * itself, which is the default spawner — tests use an injected runner so that
 * path is exercised by simulating the runner rejecting with that pre-formatted
 * error.)
 */

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
  agent: "claude-code",
  templateId: "default",
  createdAt: "2026-05-10T03:00:00.000Z",
  updatedAt: null,
  reviewedAt: null,
  reviewedBy: null,
};

function buildResearchRequest(overrides: Partial<ResearchRequest> = {}): ResearchRequest {
  return {
    agent: "claude-code",
    templateId: "default",
    templateBody: "",
    items: [SAMPLE_ITEM],
    outputPath: "/tmp/feedradar-test/research/sample_v1.md",
    cwd: "/tmp/feedradar-test",
    ...overrides,
  };
}

function buildReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    agent: "claude-code",
    templateId: "default",
    templateBody: "",
    researchPath: "/tmp/feedradar-test/research/sample_v1.md",
    researchFrontmatter: SAMPLE_RESEARCH_FM,
    researchBody: "---\nid: sample\n---\n# v1 body\n",
    cwd: "/tmp/feedradar-test",
    ...overrides,
  };
}

function buildUpdateRequest(overrides: Partial<UpdateRequest> = {}): UpdateRequest {
  return {
    agent: "claude-code",
    templateId: "default",
    templateBody: "",
    prevResearch: {
      frontmatter: SAMPLE_RESEARCH_FM,
      body: "---\nid: sample\n---\n# v1 body\n",
    },
    items: [SAMPLE_ITEM],
    outputPath:
      "/tmp/feedradar-test/research/20260510_anthropic-news-claude-code-shiny-new-feature_v2.md",
    cwd: "/tmp/feedradar-test",
    ...overrides,
  };
}

describe("agents/claude-code adapter", () => {
  describe("research", () => {
    it("invokes the runner with the research SKILL prompt and JSON stdin payload", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
      const adapter = createClaudeCodeAdapter({ run });
      const req = buildResearchRequest();

      await adapter.research(req);

      expect(run).toHaveBeenCalledTimes(1);
      const [prompt, options] = run.mock.calls[0];

      // Prompt references the research SKILL and the outputPath / item id so
      // Claude knows where to write and what to research.
      expect(prompt).toContain(".agents/skills/research/SKILL.md");
      expect(prompt).toContain(req.outputPath);
      expect(prompt).toContain(SAMPLE_ITEM.id);

      // ADR-0009 M1c: item content is wrapped in the untrusted boundary marker.
      expect(prompt).toContain("<untrusted_item>");
      expect(prompt).toContain("</untrusted_item>");

      // cwd is forwarded so `claude -p` is rooted at the workspace.
      expect(options.cwd).toBe(req.cwd);

      // stdin is a JSON document with the full ResearchRequest payload.
      const stdinJson = JSON.parse(options.stdin);
      expect(stdinJson).toEqual({
        agent: "claude-code",
        templateId: "default",
        templateBody: "",
        items: [SAMPLE_ITEM],
        outputPath: req.outputPath,
      });
    });

    it("forwards a non-default templateBody verbatim on stdin", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const adapter = createClaudeCodeAdapter({ run });
      await adapter.research(
        buildResearchRequest({ templateId: "deep-dive", templateBody: "# Deep\n" }),
      );

      const parsed = JSON.parse(run.mock.calls[0][1].stdin);
      expect(parsed.templateId).toBe("deep-dive");
      expect(parsed.templateBody).toBe("# Deep\n");
    });

    it("throws with the exit code and stderr tail when claude exits non-zero", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 2,
        stdout: "",
        stderr: "boom: research prompt rejected\n",
      });
      const adapter = createClaudeCodeAdapter({ run });

      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /claude-code adapter: claude CLI exited with code 2.*boom: research prompt rejected/s,
      );
    });

    it("falls back to stdout tail when stderr is empty on non-zero exit", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 3,
        stdout: "context lost",
        stderr: "",
      });
      const adapter = createClaudeCodeAdapter({ run });

      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /claude-code adapter: claude CLI exited with code 3.*context lost/s,
      );
    });

    it("uses '(no output)' placeholder when both streams are empty on non-zero exit", async () => {
      const run = vi.fn().mockResolvedValue({ code: 137, stdout: "", stderr: "" });
      const adapter = createClaudeCodeAdapter({ run });

      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /exited with code 137.*\(no output\)/,
      );
    });

    it("propagates ENOENT-style errors from the runner (claude CLI not on PATH)", async () => {
      const run = vi
        .fn()
        .mockRejectedValue(
          new Error(
            "claude CLI not found in PATH — install Claude Code and authenticate before running `radar research`.",
          ),
        );
      const adapter = createClaudeCodeAdapter({ run });

      await expect(adapter.research(buildResearchRequest())).rejects.toThrow(
        /claude CLI not found in PATH/,
      );
    });
  });

  describe("review", () => {
    it("invokes the runner with the review SKILL prompt and researchPath payload", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
      const adapter = createClaudeCodeAdapter({ run });
      const req = buildReviewRequest();

      await adapter.review(req);

      expect(run).toHaveBeenCalledTimes(1);
      const [prompt, options] = run.mock.calls[0];
      expect(prompt).toContain(".agents/skills/review/SKILL.md");
      expect(prompt).toContain(req.researchPath);
      // The reviewing agent id is stamped into the prompt so Claude writes
      // the matching reviewedBy frontmatter field.
      expect(prompt).toContain("claude-code");
      // ADR-0009 M1c: predecessor body is wrapped in the untrusted marker.
      expect(prompt).toContain("<untrusted_item>");
      expect(prompt).toContain("</untrusted_item>");
      // The review prompt should NOT re-invoke the research SKILL (that would
      // generate a new v1 instead of appending a review block).
      expect(prompt).not.toContain(".agents/skills/research/SKILL.md");
      expect(options.cwd).toBe(req.cwd);

      const stdinJson = JSON.parse(options.stdin);
      expect(stdinJson).toEqual({
        agent: "claude-code",
        templateId: "default",
        templateBody: "",
        researchPath: req.researchPath,
        researchFrontmatter: SAMPLE_RESEARCH_FM,
        researchBody: req.researchBody,
      });
    });

    it("throws with the exit code and stderr tail when claude exits non-zero", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 4,
        stdout: "",
        stderr: "review skill crashed",
      });
      const adapter = createClaudeCodeAdapter({ run });

      await expect(adapter.review(buildReviewRequest())).rejects.toThrow(
        /claude-code adapter: claude CLI exited with code 4.*review skill crashed/s,
      );
    });

    it("propagates runner-level errors (ENOENT) unchanged", async () => {
      const run = vi
        .fn()
        .mockRejectedValue(new Error("claude CLI not found in PATH — install Claude Code"));
      const adapter = createClaudeCodeAdapter({ run });

      await expect(adapter.review(buildReviewRequest())).rejects.toThrow(/claude CLI not found/);
    });
  });

  describe("update", () => {
    it("invokes the runner with the update SKILL prompt and predecessor id", async () => {
      const run = vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });
      const adapter = createClaudeCodeAdapter({ run });
      const req = buildUpdateRequest();

      await adapter.update(req);

      expect(run).toHaveBeenCalledTimes(1);
      const [prompt, options] = run.mock.calls[0];

      expect(prompt).toContain(".agents/skills/update/SKILL.md");
      expect(prompt).toContain(req.outputPath);
      // Predecessor id is the supersedes target we instruct the agent to write.
      expect(prompt).toContain(SAMPLE_RESEARCH_FM.id);
      expect(prompt).toContain(`supersedes: ${SAMPLE_RESEARCH_FM.id}`);
      // ADR-0009 M1c: both predecessor body and item content are wrapped.
      expect(prompt).toContain("<untrusted_item>");
      expect(prompt).toContain("</untrusted_item>");
      expect(options.cwd).toBe(req.cwd);

      const stdinJson = JSON.parse(options.stdin);
      expect(stdinJson).toEqual({
        agent: "claude-code",
        templateId: "default",
        templateBody: "",
        prevResearch: req.prevResearch,
        items: req.items,
        outputPath: req.outputPath,
      });
    });

    it("throws with the exit code and stderr tail when claude exits non-zero", async () => {
      const run = vi.fn().mockResolvedValue({
        code: 5,
        stdout: "",
        stderr: "update prompt rejected",
      });
      const adapter = createClaudeCodeAdapter({ run });

      await expect(adapter.update(buildUpdateRequest())).rejects.toThrow(
        /claude-code adapter: claude CLI exited with code 5.*update prompt rejected/s,
      );
    });

    it("propagates ENOENT-style errors from the runner", async () => {
      const run = vi
        .fn()
        .mockRejectedValue(new Error("claude CLI not found in PATH — install Claude Code"));
      const adapter = createClaudeCodeAdapter({ run });

      await expect(adapter.update(buildUpdateRequest())).rejects.toThrow(/claude CLI not found/);
    });
  });

  describe("adapter identity", () => {
    it("default adapter exposes id 'claude-code'", async () => {
      const { claudeCodeAdapter } = await import("../../src/agents/claude-code.js");
      expect(claudeCodeAdapter.id).toBe("claude-code");
    });
  });
});
