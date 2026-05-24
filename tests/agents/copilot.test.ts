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
    locale: "en",
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
    locale: "en",
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
    locale: "en",
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

describe("agents/copilot research", () => {
  it("invokes the runner with a prompt referencing the research SKILL and item ids", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.research(makeResearchRequest());

    expect(calls).toHaveLength(1);
    // The thin argv prompt references the research SKILL; ids / outputPath /
    // untrusted content ride on the stdin payload block (#272).
    expect(calls[0].prompt).toContain(".agents/skills/research/SKILL.md");
    expect(calls[0].stdin).toContain(SAMPLE_ITEM.id);
    expect(calls[0].stdin).toContain("/tmp/research/20260510_anthropic-news_v1.md");

    // Item title / summary / raw must sit inside the boundary marker pair
    // (ADR-0009 M1c) so the LLM treats the upstream-sourced content as data.
    expect(calls[0].stdin).toContain("<untrusted_item>");
    expect(calls[0].stdin).toContain("</untrusted_item>");
    expect(calls[0].stdin).toContain(SAMPLE_ITEM.title);

    expect(calls[0].cwd).toBe("/tmp/workspace");
  });

  it("carries the request fields in the stdin payload JSON fence", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.research(
      makeResearchRequest({ templateId: "deep-dive", templateBody: "# Deep\n" }),
    );

    const parsed = payloadJson(calls[0].stdin) as {
      agent: string;
      templateId: string;
      templateBody: string;
      items: { id: string }[];
      outputPath: string;
    };
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
    expect(calls[0].stdin).toContain("/tmp/research/20260510_anthropic-news_v1.md");
    expect(calls[0].stdin).toContain("stamp into reviewedBy");

    // The predecessor research body (untrusted, upstream-derived) is wrapped
    // in the boundary marker pair (ADR-0009 M1c) on stdin.
    expect(calls[0].stdin).toContain("<untrusted_item>");
    expect(calls[0].stdin).toContain("</untrusted_item>");
    expect(calls[0].stdin).toContain("---\nid: x\n---\nbody\n");

    expect(calls[0].cwd).toBe("/tmp/workspace");
  });

  it("carries the review request fields in the stdin payload JSON fence", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.review(makeReviewRequest({ templateBody: "# Review rubric\n" }));

    const parsed = payloadJson(calls[0].stdin) as {
      agent: string;
      templateId: string;
      templateBody: string;
      researchPath: string;
      researchFrontmatter: { id: string };
      researchBody: string;
    };
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
    expect(calls[0].stdin).toContain(SAMPLE_FRONTMATTER.id);
    expect(calls[0].stdin).toContain(`supersedes: ${SAMPLE_FRONTMATTER.id}`);
    expect(calls[0].stdin).toContain(
      "/tmp/research/20260510_anthropic-news-claude-code-shiny-new-feature_v2.md",
    );

    // Both the predecessor research body and per-item title/summary/raw
    // must sit inside the boundary marker pair (ADR-0009 M1c) on stdin.
    expect(calls[0].stdin).toContain("<untrusted_item>");
    expect(calls[0].stdin).toContain("</untrusted_item>");
    expect(calls[0].stdin).toContain("---\nid: x\n---\n# v1 body\n");
    expect(calls[0].stdin).toContain(SAMPLE_ITEM.title);

    expect(calls[0].cwd).toBe("/tmp/workspace");
  });

  it("carries prevResearch and items in the stdin payload JSON fence", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.update(makeUpdateRequest({ templateBody: "# Custom\n" }));

    const parsed = payloadJson(calls[0].stdin);
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

describe("agents/copilot research (multi-item digest, ADR-0011 §1)", () => {
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
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    const items = [SAMPLE_ITEM, SECOND_ITEM, THIRD_ITEM];
    await adapter.research(makeResearchRequest({ items }));

    const call = calls[0];
    const block = call.stdin;
    for (const item of items) {
      expect(block).toContain(item.id);
      expect(block).toContain(item.url);
      expect(block).toContain(item.title);
      if (item.summary !== undefined) {
        expect(block).toContain(item.summary);
      }
    }
    expect(block).toContain(items.map((i) => i.id).join(", "));

    const stdinJson = payloadJson(call.stdin) as { items: Item[] };
    expect(stdinJson.items).toEqual(items);
  });

  it("labels each item with an `### Item k of N` heading and one boundary marker per item", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    const items = [SAMPLE_ITEM, SECOND_ITEM, THIRD_ITEM];
    await adapter.research(makeResearchRequest({ items }));

    const block = calls[0].stdin;
    expect(block).toContain("### Item 1 of 3");
    expect(block).toContain("### Item 2 of 3");
    expect(block).toContain("### Item 3 of 3");
    // Closing-tag count = wrapped-item count (the M2a guidance line mentions
    // "<untrusted_item>" once without a closing tag).
    const pairCount = (block.match(/<\/untrusted_item>/g) ?? []).length;
    expect(pairCount).toBe(3);
  });

  it("emits no `### Item k of N` heading for a single-item array (regression guard)", async () => {
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    await adapter.research(makeResearchRequest());

    const block = calls[0].stdin;
    expect(block).not.toContain("### Item 1 of 1");
    const pairCount = (block.match(/<\/untrusted_item>/g) ?? []).length;
    expect(pairCount).toBe(1);
  });
});

describe("agents/copilot update (multi-item digest, ADR-0011 §4)", () => {
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
    const { runner, calls } = buildCapturingRunner({ code: 0 });
    const adapter = createCopilotAdapter({ run: runner });
    const items = [SAMPLE_ITEM, SECOND_ITEM];
    await adapter.update(makeUpdateRequest({ items }));

    const block = calls[0].stdin;
    expect(block).toContain("### Item 1 of 2");
    expect(block).toContain("### Item 2 of 2");
    expect(block).toContain(SAMPLE_ITEM.id);
    expect(block).toContain(SECOND_ITEM.id);
    // Predecessor body + 2 items = 3 boundary marker pairs (counted via the
    // closing tag; the M2a guidance line mentions the open tag once more).
    const pairCount = (block.match(/<\/untrusted_item>/g) ?? []).length;
    expect(pairCount).toBe(3);

    const stdinJson = payloadJson(calls[0].stdin) as { items: Item[] };
    expect(stdinJson.items).toEqual(items);
  });
});

describe("agents/copilot adapter identity", () => {
  it("default adapter exposes id 'copilot'", async () => {
    const { copilotAdapter } = await import("../../src/agents/copilot.js");
    expect(copilotAdapter.id).toBe("copilot");
  });
});
