import { describe, expect, it } from "vitest";
import type { CopilotRunner } from "../../src/agents/copilot.js";
import { createCopilotAdapter } from "../../src/agents/copilot.js";
import type { ResearchRequest, ReviewRequest, UpdateRequest } from "../../src/agents/index.js";
import type { Item, ResearchFrontmatter } from "../../src/schemas/index.js";
import { ItemSchema } from "../../src/schemas/index.js";

/**
 * The copilot adapter mirrors claude-code: it shells out to a CLI via
 * child_process and only verifies a non-zero exit. Tests here lock down the
 * spawn boundary — flags, stdin payload shape, exit-code propagation, and the
 * user-friendly auth-error remapping — without ever invoking the real
 * `copilot` CLI.
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

function makeResearchRequest(overrides: Partial<ResearchRequest> = {}): ResearchRequest {
  return {
    agent: "copilot",
    templateId: "default",
    templateBody: "",
    items: [SAMPLE_ITEM],
    outputPath: "/tmp/research/20260510_anthropic-news_v1.md",
    cwd: "/tmp/workspace",
    ...overrides,
  };
}

const SAMPLE_FRONTMATTER: ResearchFrontmatter = {
  id: "20260510_anthropic-news-claude-code-shiny-new-feature_v1",
  itemIds: [SAMPLE_ITEM.id],
  agent: "copilot",
  templateId: "default",
  createdAt: "2026-05-10T03:00:00.000Z",
  updatedAt: null,
  reviewedAt: null,
  reviewedBy: null,
};

function makeReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    agent: "copilot",
    templateId: "default",
    templateBody: "",
    researchPath: "/tmp/research/20260510_anthropic-news_v1.md",
    researchFrontmatter: SAMPLE_FRONTMATTER,
    researchBody: "---\nid: x\n---\nbody\n",
    cwd: "/tmp/workspace",
    ...overrides,
  };
}

function makeUpdateRequest(overrides: Partial<UpdateRequest> = {}): UpdateRequest {
  return {
    agent: "copilot",
    templateId: "default",
    templateBody: "",
    prevResearch: {
      frontmatter: SAMPLE_FRONTMATTER,
      body: "---\nid: x\n---\n# v1 body\n",
    },
    items: [SAMPLE_ITEM],
    outputPath: "/tmp/research/20260510_anthropic-news-claude-code-shiny-new-feature_v2.md",
    cwd: "/tmp/workspace",
    ...overrides,
  };
}

interface CapturedCall {
  prompt: string;
  stdin: string;
  cwd: string;
}

function buildCapturingRunner(result: { code: number; stdout?: string; stderr?: string }): {
  runner: CopilotRunner;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const runner: CopilotRunner = async (prompt, options) => {
    calls.push({ prompt, stdin: options.stdin, cwd: options.cwd });
    return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { runner, calls };
}

describe("agents/copilot research", () => {
  it("invokes the runner with a prompt referencing the research SKILL and item ids", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.research(makeResearchRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain(".agents/skills/research/SKILL.md");
    expect(calls[0].prompt).toContain(SAMPLE_ITEM.id);
    expect(calls[0].prompt).toContain("/tmp/research/20260510_anthropic-news_v1.md");
    expect(calls[0].cwd).toBe("/tmp/workspace");
  });

  it("passes a single JSON document on stdin with the request fields", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.research(
      makeResearchRequest({ templateId: "deep-dive", templateBody: "# Deep\n" }),
    );

    const parsed = JSON.parse(calls[0].stdin);
    expect(parsed.agent).toBe("copilot");
    expect(parsed.templateId).toBe("deep-dive");
    expect(parsed.templateBody).toBe("# Deep\n");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe(SAMPLE_ITEM.id);
    expect(parsed.outputPath).toBe("/tmp/research/20260510_anthropic-news_v1.md");
  });

  it("throws when the runner exits non-zero, surfacing stderr in the error message", async () => {
    const { runner } = buildCapturingRunner({ code: 3, stderr: "boom: bad thing happened" });
    const adapter = createCopilotAdapter({ run: runner });
    await expect(adapter.research(makeResearchRequest())).rejects.toThrow(
      /copilot adapter: copilot CLI exited with code 3:.*boom: bad thing happened/,
    );
  });

  it("falls back to stdout when stderr is empty on non-zero exit", async () => {
    const { runner } = buildCapturingRunner({ code: 2, stdout: "stdout-only error", stderr: "" });
    const adapter = createCopilotAdapter({ run: runner });
    await expect(adapter.research(makeResearchRequest())).rejects.toThrow(/stdout-only error/);
  });

  it("emits a user-friendly auth error when copilot stderr mentions authentication", async () => {
    const { runner } = buildCapturingRunner({
      code: 1,
      stderr: "Error: not authenticated. Please run `copilot auth login`.",
    });
    const adapter = createCopilotAdapter({ run: runner });
    await expect(adapter.research(makeResearchRequest())).rejects.toThrow(
      /GitHub Copilot CLI is not authenticated.*copilot auth login/,
    );
  });

  it("treats 401 / unauthorized as an auth error", async () => {
    const { runner } = buildCapturingRunner({ code: 1, stderr: "HTTP 401 Unauthorized" });
    const adapter = createCopilotAdapter({ run: runner });
    await expect(adapter.research(makeResearchRequest())).rejects.toThrow(
      /GitHub Copilot CLI is not authenticated/,
    );
  });
});

describe("agents/copilot review", () => {
  it("invokes the runner with a prompt referencing the review SKILL and research path", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.review(makeReviewRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain(".agents/skills/review/SKILL.md");
    expect(calls[0].prompt).toContain("/tmp/research/20260510_anthropic-news_v1.md");
    expect(calls[0].prompt).toContain("stamp this into reviewedBy");
    expect(calls[0].cwd).toBe("/tmp/workspace");
  });

  it("passes a single JSON document on stdin with the review request fields", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.review(makeReviewRequest({ templateBody: "# Review rubric\n" }));

    const parsed = JSON.parse(calls[0].stdin);
    expect(parsed.agent).toBe("copilot");
    expect(parsed.templateId).toBe("default");
    expect(parsed.templateBody).toBe("# Review rubric\n");
    expect(parsed.researchPath).toBe("/tmp/research/20260510_anthropic-news_v1.md");
    expect(parsed.researchFrontmatter.id).toBe(SAMPLE_FRONTMATTER.id);
    expect(parsed.researchBody).toBe("---\nid: x\n---\nbody\n");
  });

  it("throws when the runner exits non-zero", async () => {
    const { runner } = buildCapturingRunner({ code: 4, stderr: "review failed" });
    const adapter = createCopilotAdapter({ run: runner });
    await expect(adapter.review(makeReviewRequest())).rejects.toThrow(
      /copilot adapter: copilot CLI exited with code 4:.*review failed/,
    );
  });

  it("emits a user-friendly auth error on review when copilot reports unauthorized", async () => {
    const { runner } = buildCapturingRunner({
      code: 1,
      stderr: "authentication required: run `copilot auth login`",
    });
    const adapter = createCopilotAdapter({ run: runner });
    await expect(adapter.review(makeReviewRequest())).rejects.toThrow(
      /GitHub Copilot CLI is not authenticated.*copilot auth login/,
    );
  });

  it("uses '(no output)' placeholder when both stdout and stderr are empty", async () => {
    const { runner } = buildCapturingRunner({ code: 5, stdout: "", stderr: "" });
    const adapter = createCopilotAdapter({ run: runner });
    await expect(adapter.review(makeReviewRequest())).rejects.toThrow(/\(no output\)/);
  });
});

describe("agents/copilot update", () => {
  it("invokes the runner with a prompt referencing the update SKILL and predecessor id", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.update(makeUpdateRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain(".agents/skills/update/SKILL.md");
    expect(calls[0].prompt).toContain(SAMPLE_FRONTMATTER.id);
    expect(calls[0].prompt).toContain(`supersedes: ${SAMPLE_FRONTMATTER.id}`);
    expect(calls[0].prompt).toContain(
      "/tmp/research/20260510_anthropic-news-claude-code-shiny-new-feature_v2.md",
    );
    expect(calls[0].cwd).toBe("/tmp/workspace");
  });

  it("passes a single JSON document on stdin with prevResearch and items", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.update(makeUpdateRequest({ templateBody: "# Custom\n" }));

    const parsed = JSON.parse(calls[0].stdin);
    expect(parsed).toEqual({
      agent: "copilot",
      templateId: "default",
      templateBody: "# Custom\n",
      prevResearch: {
        frontmatter: SAMPLE_FRONTMATTER,
        body: "---\nid: x\n---\n# v1 body\n",
      },
      items: [SAMPLE_ITEM],
      outputPath: "/tmp/research/20260510_anthropic-news-claude-code-shiny-new-feature_v2.md",
    });
  });

  it("throws when copilot CLI exits non-zero, surfacing stderr in the error message", async () => {
    const { runner } = buildCapturingRunner({ code: 7, stderr: "update prompt rejected" });
    const adapter = createCopilotAdapter({ run: runner });
    await expect(adapter.update(makeUpdateRequest())).rejects.toThrow(
      /copilot adapter: copilot CLI exited with code 7:.*update prompt rejected/,
    );
  });

  it("emits a user-friendly auth error when copilot reports unauthorized on update", async () => {
    const { runner } = buildCapturingRunner({
      code: 1,
      stderr: "authentication required: run `copilot auth login`",
    });
    const adapter = createCopilotAdapter({ run: runner });
    await expect(adapter.update(makeUpdateRequest())).rejects.toThrow(
      /GitHub Copilot CLI is not authenticated.*copilot auth login/,
    );
  });
});

describe("agents/copilot adapter identity", () => {
  it("default adapter exposes id 'copilot'", async () => {
    const { copilotAdapter } = await import("../../src/agents/copilot.js");
    expect(copilotAdapter.id).toBe("copilot");
  });
});
